import { z } from "zod";
import { currentUser } from "@clerk/nextjs/server";
import { appUrl, env, notifyBaseUrl } from "@/lib/env";
import { getUserId } from "@/lib/guards";
import { getProduct } from "@/lib/products";
import { createPendingOrder, createCheckoutQuote, createOrReusePaymentAttempt, type OrderRow } from "@/lib/payments/orders";
import { createCheckoutHash, formatMinorUnits } from "@/lib/payhere/sign";
import { isSameOrigin } from "@/lib/security/origin";
import { rateLimit } from "@/lib/security/rate-limit";
import { acquireIdempotency, completeIdempotency, computeRequestFingerprint, isValidIdempotencyKey, releaseIdempotency } from "@/lib/payments/idempotency";
import { audit } from "@/lib/audit";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  sku: z.string().min(1).max(64),
  phone: z.string().regex(/^[0-9+\-\s]{7,20}$/, "Invalid phone format"),
  address: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(100),
});

const json = (body: unknown, status: number) => Response.json(body, { status });

/**
 * Checkout Initiation API (POST /api/payhere/checkout).
 * 
 * Invariants:
 * 1. Checks CSRF / Same-Origin and Clerk authentication.
 * 2. Enforces application-level Idempotency-Key: same key returns cached result, preventing duplicate attempts.
 * 3. Recomputes price/currency strictly from server catalog (client amount never accepted).
 * 4. Generates PayHere MD5 hash exclusively on the server (Merchant Secret never leaves server env).
 * 5. Returns allowlisted fields for payhere-2.0.js SDK.
 */
export async function POST(request: Request) {
  let idempotencyKey: string | null = null;
  let scope = "";

  try {
    const cfg = env();
    if (!isSameOrigin(request.headers.get("origin"), cfg.APP_URL)) {
      return json({ error: "Invalid origin" }, 403);
    }

    const userId = await getUserId();
    if (!userId) return json({ error: "Unauthorized" }, 401);

    scope = `checkout:${userId}`;

    if (!(await rateLimit(`checkout:${userId}`, 60, 15))) {
      return json({ error: "Too many checkout requests. Please wait." }, 429);
    }

    const rawBody = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return json({ error: "Invalid input", details: parsed.error.issues.map((i) => i.message) }, 400);
    }
    const { sku, phone, address, city } = parsed.data;

    // Optional Idempotency-Key header support
    idempotencyKey = request.headers.get("idempotency-key");
    if (idempotencyKey && isValidIdempotencyKey(idempotencyKey)) {
      const fingerprint = computeRequestFingerprint({ sku, phone, address, city });
      const idemResult = await acquireIdempotency(scope, idempotencyKey, fingerprint);

      if (idemResult.state === "REPLAY") {
        return json(idemResult.body, idemResult.status);
      }
      if (idemResult.state === "CONFLICT") {
        return json({ error: idemResult.error }, 409);
      }
      if (idemResult.state === "IN_PROGRESS") {
        return json({ error: "Checkout creation is already in progress for this request key." }, 409);
      }
    }

    // Server-authoritative catalog lookup
    const product = getProduct(sku);
    if (!product) return json({ error: "Unknown product" }, 400);

    const user = await currentUser();
    const email = user?.primaryEmailAddress?.emailAddress;
    if (!email) return json({ error: "User account has no verified email address" }, 400);

    // Create business order snapshot & attempt
    const order = await createPendingOrder(userId, product.sku);
    const quote = await createCheckoutQuote(userId, product, order.order_id);
    const attempt = await createOrReusePaymentAttempt(order, quote.quote_id);

    const amount = formatMinorUnits(product.amountMinor);
    const base = appUrl();

    // Hash computed server-side using attempt's provider_order_id
    const hash = createCheckoutHash({
      merchantId: cfg.PAYHERE_MERCHANT_ID,
      merchantSecret: cfg.PAYHERE_MERCHANT_SECRET,
      orderId: attempt.provider_order_id,
      amount,
      currency: product.currency,
    });

    await audit(userId, "checkout_created", {
      order_id: order.order_id,
      attempt_id: attempt.attempt_id,
      sku: product.sku,
    });

    const q = `?orderId=${encodeURIComponent(order.order_id)}`;
    const returnUrl = `${base}/payment/return${q}`;
    const cancelUrl = `${base}/payment/cancel${q}`;

    const fields: Record<string, string> = {
      merchant_id: cfg.PAYHERE_MERCHANT_ID,
      return_url: returnUrl,
      cancel_url: cancelUrl,
      notify_url: `${notifyBaseUrl()}/api/payhere/notify`,
      order_id: attempt.provider_order_id,
      items: product.name,
      currency: product.currency,
      amount,
      first_name: user?.firstName || "Customer",
      last_name: user?.lastName || "Customer",
      email,
      phone,
      address,
      city,
      country: "Sri Lanka",
      hash,
    };

    if (product.kind === "SUBSCRIPTION") {
      fields.recurrence = product.recurrence ?? "1 Month";
      fields.duration = product.duration ?? "Forever";
    }

    const responsePayload = {
      order_id: order.order_id,
      attempt_id: attempt.attempt_id,
      sandbox: cfg.PAYHERE_MODE !== "live",
      payment: fields,
      returnUrl,
      cancelUrl,
      statusUrl: `/api/orders/${order.order_id}/status`,
    };

    // Cache successful response if idempotency key was supplied
    if (idempotencyKey) {
      await completeIdempotency(scope, idempotencyKey, 200, responsePayload);
    }

    return json(responsePayload, 200);
  } catch (e) {
    if (idempotencyKey && scope) {
      await releaseIdempotency(scope, idempotencyKey);
    }
    log("error", "checkout_initiation_failed", { error: e instanceof Error ? e.message : String(e) });
    return json({ error: "Unable to create payment session. Please try again." }, 500);
  }
}
