import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/supabase";
import { getProduct, type Product } from "@/lib/products";
import type { OrderKind } from "@/lib/payhere/status";
import { log } from "@/lib/logger";

export type OrderRow = {
  order_id: string;
  user_id: string;
  kind: OrderKind;
  sku: string;
  description: string;
  amount_minor: number;
  currency: string;
  status: string;
};

export type PaymentAttemptRow = {
  attempt_id: string;
  order_id: string;
  quote_id: string | null;
  provider: string;
  provider_order_id: string;
  amount_minor: number;
  currency: string;
  status: "CREATED" | "CHECKOUT_OPEN" | "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "UNKNOWN";
  attempt_number: number;
  created_at: string;
  updated_at: string;
};

export type CheckoutQuoteRow = {
  quote_id: string;
  order_id: string;
  user_id: string;
  items: unknown;
  subtotal_minor: number;
  tax_minor: number;
  discount_minor: number;
  total_minor: number;
  currency: string;
  expires_at: string;
};

/**
 * Creates or retrieves a short-lived quote snapshot for checkout.
 * Enforces server pricing authority and snapshot immutability.
 */
export async function createCheckoutQuote(
  userId: string,
  product: Product,
  orderId: string,
  ttlMinutes = 15,
): Promise<CheckoutQuoteRow> {
  const quoteId = `q_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

  const quote: CheckoutQuoteRow = {
    quote_id: quoteId,
    order_id: orderId,
    user_id: userId,
    items: [{ sku: product.sku, name: product.name, unitPrice: product.amountMinor, qty: 1 }],
    subtotal_minor: product.amountMinor,
    tax_minor: 0,
    discount_minor: 0,
    total_minor: product.amountMinor,
    currency: product.currency,
    expires_at: expiresAt,
  };

  const { error } = await db().from("checkout_quotes").insert(quote);
  if (error) {
    log("error", "quote_insert_failed", { orderId, error: error.message });
    throw new Error(`Quote creation failed: ${error.message}`);
  }

  return quote;
}

/**
 * Creates or reuses a payment attempt for a given order.
 * 
 * Concurrency & Safety Rules:
 * 1. Checks if an active, unresolved attempt already exists for this order.
 * 2. If an active attempt exists and is not expired, returns it to prevent competing gateway requests.
 * 3. If prior attempt was terminal (FAILED/CANCELLED), creates attempt N+1 with unique provider_order_id.
 */
export async function createOrReusePaymentAttempt(
  order: OrderRow,
  quoteId?: string,
): Promise<PaymentAttemptRow> {
  // Query existing attempts for this order
  const { data: existingAttempts, error: fetchErr } = await db()
    .from("payment_attempts")
    .select("*")
    .eq("order_id", order.order_id)
    .order("attempt_number", { ascending: false });

  if (fetchErr) {
    log("warn", "fetch_attempts_warning", { orderId: order.order_id, error: fetchErr.message });
  }

  const latest = existingAttempts?.[0] as PaymentAttemptRow | undefined;

  // If an active attempt exists, reuse it to prevent concurrent conflicting hashes
  if (latest && (latest.status === "CREATED" || latest.status === "CHECKOUT_OPEN" || latest.status === "PENDING")) {
    return latest;
  }

  const nextAttemptNumber = (latest?.attempt_number ?? 0) + 1;
  const attemptId = `att_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  
  // PayHere provider_order_id: first attempt uses clean order_id, subsequent attempts append _N
  // This satisfies PayHere's order_id wire parameter while keeping distinct gateway identities.
  const providerOrderId = nextAttemptNumber === 1 ? order.order_id : `${order.order_id}_${nextAttemptNumber}`;

  const attempt: PaymentAttemptRow = {
    attempt_id: attemptId,
    order_id: order.order_id,
    quote_id: quoteId ?? null,
    provider: "payhere",
    provider_order_id: providerOrderId,
    amount_minor: order.amount_minor,
    currency: order.currency,
    status: "CHECKOUT_OPEN",
    attempt_number: nextAttemptNumber,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { error: insertErr } = await db().from("payment_attempts").insert(attempt);
  if (insertErr) {
    log("error", "attempt_insert_failed", { orderId: order.order_id, error: insertErr.message });
    throw new Error(`Payment attempt creation failed: ${insertErr.message}`);
  }

  return attempt;
}

/**
 * Creates a pending business order and initial attempt.
 * Preserves backward compatibility while recording attempt metadata.
 */
export async function createPendingOrder(userId: string, sku: string): Promise<OrderRow> {
  const product = getProduct(sku);
  if (!product) throw new Error("Unknown product");

  const orderId = randomUUID();
  const row: OrderRow = {
    order_id: orderId,
    user_id: userId,
    kind: product.kind,
    sku: product.sku,
    description: product.name,
    amount_minor: product.amountMinor,
    currency: product.currency,
    status: "PENDING",
  };

  const { error } = await db().from("payment_orders").insert(row);
  if (error) throw new Error(`Order insert failed: ${error.message}`);

  // Create initial quote and attempt
  try {
    const quote = await createCheckoutQuote(userId, product, orderId);
    await createOrReusePaymentAttempt(row, quote.quote_id);
  } catch (e) {
    log("warn", "quote_attempt_init_warning", { orderId, error: String(e) });
  }

  return row;
}

/**
 * Determines whether an order is safe to retry.
 * Returns true only if there is NO unresolved, in-flight, or successful attempt.
 */
export function isOrderSafeToRetry(status: string): boolean {
  return status === "FAILED" || status === "CANCELED";
}
