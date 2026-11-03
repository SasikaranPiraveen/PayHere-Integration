import "server-only";
import { db } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { searchPayHerePayment } from "./client";
import { formatMinorUnits } from "./sign";
import { env } from "@/lib/env";

export type ReconciliationSummary = {
  checked: number;
  reconciled: number;
  expired: number;
  mismatches: number;
};

/**
 * Reconciles unresolved and stale PENDING payments against PayHere's Retrieval API.
 * 
 * Invariants (Handbook Section 16):
 * 1. An empty search result alone is NOT instantaneous proof of no payment.
 * 2. Only attempts older than minAgeMinutes (e.g. 5m) are polled to allow normal webhook delivery.
 * 3. Attempts older than maxExpiryMinutes (e.g. 60m) with zero provider records transition to EXPIRED.
 * 4. Discovered payments are reconciled atomically via apply_payhere_event_v2.
 */
export async function reconcileStalePendingPayments(
  minAgeMinutes = 5,
  maxExpiryMinutes = 60,
): Promise<ReconciliationSummary> {
  const summary: ReconciliationSummary = {
    checked: 0,
    reconciled: 0,
    expired: 0,
    mismatches: 0,
  };

  const minCutoff = new Date(Date.now() - minAgeMinutes * 60 * 1000).toISOString();
  const maxCutoff = new Date(Date.now() - maxExpiryMinutes * 60 * 1000).toISOString();

  // 1. Fetch pending orders older than minCutoff
  const { data: staleOrders, error: orderErr } = await db()
    .from("payment_orders")
    .select("order_id, kind, sku, amount_minor, currency, status, created_at")
    .eq("status", "PENDING")
    .lte("created_at", minCutoff)
    .order("created_at", { ascending: true })
    .limit(25);

  if (orderErr) {
    log("error", "reconciliation_query_failed", { error: orderErr.message });
    return summary;
  }

  if (!staleOrders || staleOrders.length === 0) {
    return summary;
  }

  summary.checked = staleOrders.length;
  log("info", "reconciliation_run_started", { count: staleOrders.length });

  for (const order of staleOrders) {
    try {
      // Find latest attempt for this order
      const { data: attempt } = await db()
        .from("payment_attempts")
        .select("attempt_id, provider_order_id, status")
        .eq("order_id", order.order_id)
        .order("attempt_number", { ascending: false })
        .limit(1)
        .maybeSingle();

      const providerOrderId = attempt?.provider_order_id ?? order.order_id;

      // Query PayHere Retrieval API
      const searchRes = await searchPayHerePayment(providerOrderId);

      if (searchRes.status === 1 && searchRes.data && searchRes.data.length > 0) {
        // Successful payment found at PayHere!
        const paymentRecord = searchRes.data.find((p) => p.status === "RECEIVED") ?? searchRes.data[0];
        const receivedAmountStr = Number(paymentRecord.amount).toFixed(2);
        const expectedAmountStr = formatMinorUnits(order.amount_minor);

        if (receivedAmountStr !== expectedAmountStr || paymentRecord.currency !== order.currency) {
          log("error", "reconciliation_amount_mismatch", {
            orderId: order.order_id,
            received: receivedAmountStr,
            expected: expectedAmountStr,
          });
          summary.mismatches += 1;
          continue;
        }

        // Apply reconciliation through database atomic event function
        const cfg = env();
        const rpcPayload = {
          p_fingerprint: `reconcile_${order.order_id}_${paymentRecord.payment_id}`,
          p_merchant_id: cfg.PAYHERE_MERCHANT_ID,
          p_order_id: order.order_id,
          p_payment_id: String(paymentRecord.payment_id),
          p_subscription_id: null,
          p_status_code: "2",
          p_message_type: null,
          p_new_status: "PAID",
          p_amount_minor: Number(order.amount_minor),
          p_currency: order.currency,
          p_payload: { source: "reconciliation_api", record: paymentRecord },
        };

        const { data: outcome, error: rpcErr } = await db().rpc("apply_payhere_event_v2", rpcPayload);
        if (rpcErr) throw new Error(rpcErr.message);

        if (outcome === "APPLIED" || outcome === "DUPLICATE") {
          summary.reconciled += 1;
          log("info", "order_reconciled_successfully", { orderId: order.order_id, paymentId: paymentRecord.payment_id });
        }
      } else if (searchRes.status === -1) {
        // PayHere has no record of payment
        // If order is older than maxCutoff, transition to FAILED so customer is not stuck
        if (new Date(order.created_at) < new Date(maxCutoff)) {
          await db()
            .from("payment_orders")
            .update({ status: "FAILED", updated_at: new Date().toISOString() })
            .eq("order_id", order.order_id)
            .eq("status", "PENDING"); // Conditional update

          if (attempt) {
            await db()
              .from("payment_attempts")
              .update({ status: "FAILED", updated_at: new Date().toISOString() })
              .eq("attempt_id", attempt.attempt_id);
          }

          summary.expired += 1;
          log("info", "stale_pending_order_expired", { orderId: order.order_id });
        }
      }
    } catch (e) {
      log("error", "order_reconciliation_failed", { orderId: order.order_id, error: String(e) });
    }
  }

  // Record audit of this reconciliation run
  try {
    await db().from("reconciliation_runs").insert({
      run_type: "SCHEDULED_AUTOMATED",
      items_checked: summary.checked,
      mismatches_found: summary.mismatches,
      status: "COMPLETED",
      completed_at: new Date().toISOString(),
      details: summary,
    });
  } catch (e) {
    log("warn", "reconciliation_run_log_failed", { error: String(e) });
  }

  return summary;
}

