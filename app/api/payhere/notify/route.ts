import { processPayHereNotification } from "@/lib/payments/process-notify";
import { clientIp } from "@/lib/security/origin";
import { rateLimit } from "@/lib/security/rate-limit";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Maximum allowable callback payload size (64 KB) to protect against memory exhaustion attacks
const MAX_BODY_BYTES = 64 * 1024;

// Critical parameters that must NEVER be duplicated in the form submission (parameter pollution defense)
const CRITICAL_KEYS = new Set([
  "merchant_id",
  "order_id",
  "payment_id",
  "payhere_amount",
  "payhere_currency",
  "status_code",
  "md5sig",
]);

/**
 * PayHere Server-to-Server Webhook Endpoint (POST notify_url).
 * 
 * Security & Protocol Invariants:
 * 1. Must be public and unauthenticated by browser session (PayHere is not a logged-in user).
 * 2. Authenticated strictly by PayHere MD5 checksum (md5sig) + matching server snapshot.
 * 3. Enforces application/x-www-form-urlencoded Content-Type (rejects JSON or multipart payloads).
 * 4. Strictly checks for duplicate parameters to prevent HTTP Parameter Pollution (HPP).
 * 5. Webhook rate limiter fails open so legitimate payments are never rejected due to limiter latency.
 */
export async function POST(request: Request) {
  const ip = clientIp(request.headers);

  // 1. Fail-open rate limit: never drop a genuine payment notification if rate limiter storage blips
  if (!(await rateLimit(`notify:${ip}`, 60, 120, true))) {
    log("warn", "webhook_rate_limited", { ip });
    return new Response("Too many requests", { status: 429 });
  }

  // 2. Validate Content-Type: PayHere explicitly documents 'application/x-www-form-urlencoded'
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    log("warn", "webhook_invalid_content_type", { ip, contentType });
    return new Response("Invalid Content-Type; expected application/x-www-form-urlencoded", { status: 415 });
  }

  // 3. Bounded body read (prevent DoS memory exhaustion)
  let rawBodyText: string;
  try {
    const rawBuffer = await request.arrayBuffer();
    if (rawBuffer.byteLength > MAX_BODY_BYTES) {
      log("warn", "webhook_payload_oversized", { ip, bytes: rawBuffer.byteLength });
      return new Response("Payload too large", { status: 413 });
    }
    rawBodyText = new TextDecoder("utf-8").decode(rawBuffer);
  } catch (e) {
    log("error", "webhook_read_body_failed", { ip, error: String(e) });
    return new Response("Bad request", { status: 400 });
  }

  // 4. Parse URL-encoded parameters and check for HTTP Parameter Pollution (HPP)
  const searchParams = new URLSearchParams(rawBodyText);
  const raw: Record<string, string> = {};

  for (const key of searchParams.keys()) {
    const allValues = searchParams.getAll(key);
    if (CRITICAL_KEYS.has(key) && allValues.length > 1) {
      log("warn", "webhook_parameter_pollution_detected", { ip, key, count: allValues.length });
      return new Response(`Duplicate critical parameter: ${key}`, { status: 400 });
    }
    // Take the single validated value
    raw[key] = allValues[0];
  }

  // 5. Process callback through business state engine
  const outcome = await processPayHereNotification(raw, ip);
  return new Response(outcome.message, { status: outcome.httpStatus });
}
