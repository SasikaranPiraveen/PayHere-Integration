// Pure PayHere protocol helpers (no framework imports, fully unit-testable).
// NOTE: MD5 is mandated by PayHere's wire protocol. It is NOT our own security design;
// we add amount/currency/merchant validation, constant-time compare and replay protection on top.
import { createHash, timingSafeEqual } from "node:crypto";

export function md5Upper(value: string): string {
  return createHash("md5").update(value, "utf8").digest("hex").toUpperCase();
}

/** Integer minor units (cents) -> "1234.56". PayHere requires exactly two decimals. */
export function formatMinorUnits(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new Error("amountMinor must be a non-negative safe integer");
  }
  const major = Math.floor(amountMinor / 100);
  const minor = amountMinor % 100;
  return `${major}.${minor.toString().padStart(2, "0")}`;
}

export function createCheckoutHash(input: {
  merchantId: string;
  merchantSecret: string;
  orderId: string;
  amount: string; // exactly "1234.56"
  currency: string;
}): string {
  return md5Upper(
    input.merchantId + input.orderId + input.amount + input.currency + md5Upper(input.merchantSecret),
  );
}

export type PayHereNotification = {
  merchant_id: string;
  order_id: string;
  payment_id?: string;
  payhere_amount: string;
  payhere_currency: string;
  status_code: string;
  md5sig: string;
  subscription_id?: string;
  recurring?: string;
  message_type?: string;
};

export function notificationSignature(
  n: Omit<PayHereNotification, "md5sig">,
  merchantSecret: string,
): string {
  return md5Upper(
    n.merchant_id + n.order_id + n.payhere_amount + n.payhere_currency + n.status_code + md5Upper(merchantSecret),
  );
}

export function verifyPayHereNotification(n: PayHereNotification, merchantSecret: string): boolean {
  const provided = (n.md5sig ?? "").trim().toUpperCase();
  if (!/^[0-9A-F]{32}$/.test(provided)) return false;
  const expected = notificationSignature(n, merchantSecret);
  return timingSafeEqual(Buffer.from(expected, "ascii"), Buffer.from(provided, "ascii"));
}

/** Stable SHA-256 over all callback fields; used as the idempotency / replay key. */
export function eventFingerprint(fields: Record<string, string>): string {
  const canonical = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("&");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
