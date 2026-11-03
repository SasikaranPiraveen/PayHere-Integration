import { db } from "@/lib/supabase";
import { getUserId } from "@/lib/guards";
import { isOrderSafeToRetry } from "@/lib/payments/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Authoritative Payment & Fulfillment Status Endpoint (GET /api/orders/{id}/status).
 * 
 * Invariants (Handbook Section 5.3):
 * 1. Strict object-level authorization (IDOR protection): only the order owner can query it.
 * 2. Cache-Control: private, no-store (prevents CDN/shared proxy caching of financial status).
 * 3. Returns server-determined can_retry flag (never computed client-side).
 * 4. Separates payment status from fulfillment status.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getUserId();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id || id.length > 128) {
    return Response.json({ error: "Invalid order ID" }, { status: 400 });
  }

  // Look up order scoped by user_id
  const { data: order, error: orderErr } = await db()
    .from("payment_orders")
    .select("order_id, status, amount_minor, currency, updated_at")
    .eq("order_id", id)
    .eq("user_id", userId)
    .maybeSingle();

  if (orderErr) return Response.json({ error: "Database error" }, { status: 500 });
  if (!order) return Response.json({ error: "Order not found" }, { status: 404 });

  // Query latest attempt for this order
  const { data: attempt } = await db()
    .from("payment_attempts")
    .select("attempt_id, status")
    .eq("order_id", id)
    .order("attempt_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Query fulfillment state
  const { data: fulfillment } = await db()
    .from("fulfillments")
    .select("fulfilled_at")
    .eq("order_id", id)
    .maybeSingle();

  const fulfillmentState = fulfillment ? "SUCCEEDED" : (order.status === "PAID" || order.status === "ACTIVE" ? "QUEUED" : "NOT_READY");
  const canRetry = isOrderSafeToRetry(order.status);

  // Compute standard display message code
  let messageCode = "VERIFYING";
  if (order.status === "PAID" || order.status === "ACTIVE") {
    messageCode = fulfillment ? "FULFILLED" : "FULFILLMENT_PENDING";
  } else if (order.status === "FAILED") {
    messageCode = "FAILED_VERIFIED";
  } else if (order.status === "CANCELED") {
    messageCode = "CANCELLED_VERIFIED";
  } else if (order.status === "CHARGEDBACK") {
    messageCode = "REVIEW_REQUIRED";
  }

  const responseBody = {
    order_id: order.order_id,
    attempt_id: attempt?.attempt_id ?? null,
    payment_state: order.status,
    fulfillment_state: fulfillmentState,
    amount_minor: order.amount_minor,
    currency: order.currency,
    display_message_code: messageCode,
    can_retry: canRetry,
    updated_at: order.updated_at,
  };

  return Response.json(responseBody, {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
    },
  });
}
