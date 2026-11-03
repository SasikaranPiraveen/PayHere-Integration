import "server-only";
import { db } from "@/lib/supabase";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import {
  eventFingerprint, formatMinorUnits, verifyPayHereNotification, type PayHereNotification,
} from "@/lib/payhere/sign";
import { mapStatus, type OrderKind } from "@/lib/payhere/status";

export type WebhookResult =
  | "ACCEPTED" | "DUPLICATE" | "OVERPAYMENT" | "IGNORED" | "INVALID_SIGNATURE" | "WRONG_MERCHANT"
  | "AMOUNT_MISMATCH" | "UNKNOWN_ORDER" | "BAD_REQUEST" | "ERROR";

export type NotifyOutcome = { httpStatus: number; result: WebhookResult; message: string };

/**
 * Authoritative payment notification processor.
 * Used by the webhook route (app/api/payhere/notify).
 * 
 * Evaluation Hierarchy (strict fail-fast):
 * 1. Payload structural check (presence & bounds of required wire fields).
 * 2. Merchant ID verification (must match configured merchant account for this environment).
 * 3. Constant-time cryptographic signature verification (md5sig).
 * 4. Database existence check for order / attempt.
 * 5. Commercial snapshot re-verification (exact amount and currency match).
 * 6. Atomic, serialized state transition & financial ledger posting in PostgreSQL.
 */
export async function processPayHereNotification(raw: Record<string, string>, ip: string): Promise<NotifyOutcome> {
  const started = Date.now();
  const cfg = env();

  const done = async (httpStatus: number, result: WebhookResult, message: string): Promise<NotifyOutcome> => {
    const latencyMs = Date.now() - started;
    log(result === "ACCEPTED" || result === "DUPLICATE" || result === "OVERPAYMENT" ? "info" : "warn", "payhere_webhook", {
      result,
      order_id: raw.order_id,
      payment_id: raw.payment_id,
      message_type: raw.message_type,
      status_code: raw.status_code,
      latencyMs,
    });

    try {
      const { error } = await db().from("webhook_log").insert({
        order_id: raw.order_id?.slice(0, 100) ?? null,
        result,
        message_type: raw.message_type ?? null,
        status_code: raw.status_code ?? null,
        latency_ms: latencyMs,
        ip,
      });
      if (error) log("error", "webhook_log_insert_failed", { error: error.message });
    } catch (e) {
      log("error", "webhook_log_insert_threw", { error: String(e) });
    }

    return { httpStatus, result, message };
  };

  // 1. Structural check
  const required = ["merchant_id", "order_id", "payhere_amount", "payhere_currency", "status_code", "md5sig"];
  if (required.some((k) => !raw[k]) || raw.order_id.length > 128) {
    return done(400, "BAD_REQUEST", "Malformed notification parameters");
  }

  const n: PayHereNotification = {
    merchant_id: raw.merchant_id,
    order_id: raw.order_id,
    payment_id: raw.payment_id,
    payhere_amount: raw.payhere_amount,
    payhere_currency: raw.payhere_currency,
    status_code: raw.status_code,
    md5sig: raw.md5sig,
    subscription_id: raw.subscription_id,
    recurring: raw.recurring,
    message_type: raw.message_type,
  };

  // 2. Merchant ID check
  if (n.merchant_id !== cfg.PAYHERE_MERCHANT_ID) {
    log("warn", "webhook_wrong_merchant", { received: n.merchant_id, expected: cfg.PAYHERE_MERCHANT_ID });
    return done(400, "WRONG_MERCHANT", "Wrong merchant ID");
  }

  // 3. Constant-time MD5 signature check
  if (!verifyPayHereNotification(n, cfg.PAYHERE_MERCHANT_SECRET)) {
    log("warn", "webhook_invalid_signature", { order_id: n.order_id, payment_id: n.payment_id });
    return done(400, "INVALID_SIGNATURE", "Invalid signature");
  }

  try {
    // 4. Resolve business order (supports both direct order_id and attempt provider_order_id)
    let businessOrderId = n.order_id;
    const { data: attempt } = await db()
      .from("payment_attempts")
      .select("order_id, amount_minor, currency")
      .eq("provider_order_id", n.order_id)
      .maybeSingle();

    if (attempt) {
      businessOrderId = attempt.order_id;
    }

    const { data: order, error: orderErr } = await db()
      .from("payment_orders")
      .select("order_id, kind, amount_minor, currency, status")
      .eq("order_id", businessOrderId)
      .maybeSingle();

    if (orderErr) throw new Error(orderErr.message);
    if (!order) {
      log("warn", "webhook_unknown_order", { order_id: n.order_id, businessOrderId });
      return done(404, "UNKNOWN_ORDER", "Unknown order");
    }

    // 5. Commercial snapshot re-verification
    // Signature proves message was generated with merchant secret; this check proves it matches OUR order snapshot
    const expectedAmount = formatMinorUnits(Number(order.amount_minor));
    if (n.payhere_amount !== expectedAmount || n.payhere_currency !== order.currency) {
      log("error", "webhook_amount_mismatch", {
        order_id: order.order_id,
        receivedAmount: n.payhere_amount,
        expectedAmount,
        receivedCurrency: n.payhere_currency,
        expectedCurrency: order.currency,
      });
      return done(400, "AMOUNT_MISMATCH", "Amount or currency mismatch with stored order snapshot");
    }

    // Map status according to documented PayHere rules
    const status = mapStatus(order.kind as OrderKind, n.message_type, n.status_code);
    if (status === "UNKNOWN") {
      log("warn", "webhook_unknown_status_code", { status_code: n.status_code, message_type: n.message_type });
      return done(200, "IGNORED", "Unknown status code; ignored");
    }

    // 6. Atomic state transition in PostgreSQL
    // Tries apply_payhere_event_v2 first, falls back gracefully to apply_payhere_event for backward compatibility
    let outcome: string | null = null;
    const rpcPayload = {
      p_fingerprint: eventFingerprint(raw),
      p_merchant_id: n.merchant_id,
      p_order_id: order.order_id,
      p_payment_id: n.payment_id ?? null,
      p_subscription_id: n.subscription_id ?? null,
      p_status_code: n.status_code,
      p_message_type: n.message_type ?? null,
      p_new_status: status,
      p_amount_minor: Number(order.amount_minor),
      p_currency: order.currency,
      p_payload: raw,
    };

    const { data: v2Data, error: v2Error } = await db().rpc("apply_payhere_event_v2", rpcPayload);
    if (!v2Error) {
      outcome = v2Data;
    } else {
      // Fallback to v1 if migration not yet applied
      log("warn", "v2_rpc_fallback", { error: v2Error.message });
      const { data: v1Data, error: v1Error } = await db().rpc("apply_payhere_event", {
        p_fingerprint: rpcPayload.p_fingerprint,
        p_order_id: rpcPayload.p_order_id,
        p_payment_id: rpcPayload.p_payment_id,
        p_subscription_id: rpcPayload.p_subscription_id,
        p_status_code: rpcPayload.p_status_code,
        p_message_type: rpcPayload.p_message_type,
        p_new_status: rpcPayload.p_new_status,
        p_amount_minor: rpcPayload.p_amount_minor,
        p_currency: rpcPayload.p_currency,
      });
      if (v1Error) throw new Error(v1Error.message);
      outcome = v1Data;
    }

    switch (outcome) {
      case "APPLIED":
        return done(200, "ACCEPTED", "Payment event applied successfully");
      case "DUPLICATE":
        return done(200, "DUPLICATE", "Duplicate event recognized; no re-posting");
      case "OVERPAYMENT_RECORDED":
        return done(200, "OVERPAYMENT", "Secondary payment recorded in ledger and queued for review");
      case "IGNORED":
        return done(200, "IGNORED", "State transition not permitted; ignored");
      case "UNKNOWN_ORDER":
        return done(404, "UNKNOWN_ORDER", "Order not found during state update");
      default:
        throw new Error(`Unexpected database outcome: ${String(outcome)}`);
    }
  } catch (e) {
    log("error", "payhere_webhook_processing_exception", {
      order_id: n.order_id,
      payment_id: n.payment_id,
      error: e instanceof Error ? e.message : String(e),
    });
    // Return 500 so upstream provider / reconciliation engine knows durable persistence was not completed
    return done(500, "ERROR", "Internal processing error");
  }
}
