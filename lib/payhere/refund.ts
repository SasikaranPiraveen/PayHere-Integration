import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { merchantApiCredentials } from "@/lib/env";
import { submitPayHereRefund } from "./client";
import { formatMinorUnits } from "./sign";

export type RefundRequestInput = {
  orderId: string;
  amountMinor?: number; // Optional for partial refund; if omitted, full refundable balance is used
  reason: string;
  adminId: string;
};

export type RefundExecutionResult =
  | { success: true; refundOperationId: number; providerRefundId: string | number; amountMinor: number }
  | { success: false; error: string; state?: "FAILED" | "UNKNOWN" };

/**
 * Executes an auditable, bounded refund against a paid order.
 * 
 * Rules (Handbook Section 13):
 * 1. Checks net captured balance: Total Captured - Settled Refunds - In-flight Refunds.
 * 2. Rejects any refund exceeding available captured funds.
 * 3. Records durable refund_operations record before external API call.
 * 4. Calls PayHere Refund API outside the database transaction.
 * 5. On provider acceptance, inserts an immutable negative REFUND ledger entry.
 * 6. Never deletes or mutates original payment records.
 * 7. On ambiguous network timeout, marks UNKNOWN to forbid blind re-submissions.
 */
export async function executeRefund(input: RefundRequestInput): Promise<RefundExecutionResult> {
  const { orderId, amountMinor, reason, adminId } = input;
  log("info", "refund_requested", { orderId, amountMinor, reason, adminId });

  // Checked before any refund_operations row exists, so a misconfiguration can't leave one stuck in-flight.
  try {
    merchantApiCredentials();
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }

  // 1. Fetch order
  const { data: order, error: orderErr } = await db()
    .from("payment_orders")
    .select("order_id, status, amount_minor, currency, provider_payment_id")
    .eq("order_id", orderId)
    .maybeSingle();

  if (orderErr || !order) {
    return { success: false, error: "Order not found" };
  }

  if (order.status !== "PAID" && order.status !== "ACTIVE") {
    return { success: false, error: "Only paid orders are eligible for refunds." };
  }

  if (!order.provider_payment_id) {
    return { success: false, error: "No provider payment ID associated with this order." };
  }

  // 2. Calculate net refundable balance
  const { data: ledgerEntries, error: ledgerErr } = await db()
    .from("ledger_entries")
    .select("entry_type, amount_minor")
    .eq("order_id", orderId);

  if (ledgerErr) {
    return { success: false, error: "Failed to read financial ledger for balance verification." };
  }

  let captured = 0;
  let alreadyRefunded = 0;
  for (const entry of ledgerEntries ?? []) {
    if (entry.entry_type === "PAYMENT" || entry.entry_type === "INSTALLMENT") {
      captured += Number(entry.amount_minor);
    } else if (entry.entry_type === "REFUND" || entry.entry_type === "CHARGEBACK") {
      alreadyRefunded += Math.abs(Number(entry.amount_minor));
    }
  }

  // Check in-flight refunds
  const { data: inFlightRefunds } = await db()
    .from("refund_operations")
    .select("amount_minor")
    .eq("order_id", orderId)
    .in("status", ["REQUESTED", "SUBMITTED", "UNKNOWN"]);

  let inFlight = 0;
  for (const inf of inFlightRefunds ?? []) {
    inFlight += Number(inf.amount_minor);
  }

  const maxRefundable = captured - alreadyRefunded - inFlight;
  if (maxRefundable <= 0) {
    return { success: false, error: "This order has no remaining refundable balance." };
  }

  const targetRefundMinor = amountMinor ? Math.min(amountMinor, maxRefundable) : maxRefundable;
  if (targetRefundMinor <= 0) {
    return { success: false, error: "Invalid refund amount requested." };
  }

  const refundKey = `ref_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

  // 3. Insert durable refund_operations record in REQUESTED state
  const { data: opData, error: opErr } = await db()
    .from("refund_operations")
    .insert({
      refund_key: refundKey,
      order_id: orderId,
      provider_payment_id: order.provider_payment_id,
      amount_minor: targetRefundMinor,
      currency: order.currency,
      reason,
      status: "SUBMITTED",
      requested_by: adminId,
    })
    .select("id")
    .single();

  if (opErr || !opData) {
    return { success: false, error: `Failed to create refund operation: ${opErr?.message}` };
  }

  const refundOpId = opData.id;

  // 4. Submit to PayHere Refund API outside database transaction
  const amountStr = (targetRefundMinor < order.amount_minor) ? formatMinorUnits(targetRefundMinor) : undefined;
  const refundRes = await submitPayHereRefund(order.provider_payment_id, reason, amountStr);

  // 5. Handle Provider Result
  if (refundRes.status === 1 && refundRes.data) {
    // Successfully accepted by PayHere!
    const providerRefId = String(refundRes.data);

    // Update refund_operations
    await db()
      .from("refund_operations")
      .update({
        status: "PROVIDER_ACCEPTED",
        provider_refund_id: providerRefId,
        approved_by: adminId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", refundOpId);

    // Insert negative REFUND entry in append-only ledger
    const postingKey = `post_refund_${orderId}_${providerRefId}`;
    await db().from("ledger_entries").insert({
      order_id: orderId,
      entry_type: "REFUND",
      amount_minor: -targetRefundMinor,
      currency: order.currency,
      provider_payment_id: order.provider_payment_id,
      posting_key: postingKey,
    });

    log("info", "refund_completed_successfully", { orderId, refundOpId, providerRefId, amountMinor: targetRefundMinor });
    return { success: true, refundOperationId: refundOpId, providerRefundId: providerRefId, amountMinor: targetRefundMinor };
  } else if (refundRes.status === 0) {
    // Network or provider timeout -> UNKNOWN state (forbids automatic re-posting)
    await db()
      .from("refund_operations")
      .update({ status: "UNKNOWN", updated_at: new Date().toISOString() })
      .eq("id", refundOpId);

    log("warn", "refund_outcome_unknown", { orderId, refundOpId, msg: refundRes.msg });
    return { success: false, state: "UNKNOWN", error: "Refund request timed out. Status marked UNKNOWN; reconcile before re-attempting." };
  } else {
    // Provider explicit decline
    await db()
      .from("refund_operations")
      .update({ status: "FAILED", updated_at: new Date().toISOString() })
      .eq("id", refundOpId);

    log("warn", "refund_declined_by_provider", { orderId, refundOpId, msg: refundRes.msg });
    return { success: false, state: "FAILED", error: `PayHere refund declined: ${refundRes.msg}` };
  }
}

