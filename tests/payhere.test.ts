import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createCheckoutHash, eventFingerprint, formatMinorUnits, md5Upper,
  notificationSignature, verifyPayHereNotification, type PayHereNotification,
} from "../lib/payhere/sign.ts";
import { mapStatus } from "../lib/payhere/status.ts";
import { clientIp, isSameOrigin } from "../lib/security/origin.ts";
import { redact } from "../lib/logger.ts";

const SECRET = "test-secret";
const md5 = (s: string) => createHash("md5").update(s).digest("hex").toUpperCase();

function notif(over: Partial<PayHereNotification> = {}): PayHereNotification {
  const base = {
    merchant_id: "1210000", order_id: "order-1", payment_id: "320032",
    payhere_amount: "2500.00", payhere_currency: "LKR", status_code: "2",
  };
  const merged = { ...base, ...over };
  return { ...merged, md5sig: over.md5sig ?? notificationSignature(merged, SECRET) };
}

test("formatMinorUnits: two decimals, rejects bad input", () => {
  assert.equal(formatMinorUnits(250_000), "2500.00");
  assert.equal(formatMinorUnits(1), "0.01");
  assert.equal(formatMinorUnits(0), "0.00");
  assert.equal(formatMinorUnits(1999), "19.99");
  assert.throws(() => formatMinorUnits(-1));
  assert.throws(() => formatMinorUnits(1.5));
});

test("checkout hash matches the documented formula (independent recompute)", () => {
  const expected = md5("1210000" + "order-1" + "2500.00" + "LKR" + md5(SECRET));
  assert.equal(
    createCheckoutHash({ merchantId: "1210000", merchantSecret: SECRET, orderId: "order-1", amount: "2500.00", currency: "LKR" }),
    expected,
  );
});

test("checkout hash changes when amount, currency or order changes", () => {
  const base = { merchantId: "1", merchantSecret: SECRET, orderId: "o", amount: "10.00", currency: "LKR" };
  const h = createCheckoutHash(base);
  assert.notEqual(h, createCheckoutHash({ ...base, amount: "1.00" }));
  assert.notEqual(h, createCheckoutHash({ ...base, currency: "USD" }));
  assert.notEqual(h, createCheckoutHash({ ...base, orderId: "p" }));
});

test("notification: valid signature accepted (case-insensitive)", () => {
  const n = notif();
  assert.equal(verifyPayHereNotification(n, SECRET), true);
  assert.equal(verifyPayHereNotification({ ...n, md5sig: n.md5sig.toLowerCase() }, SECRET), true);
});

test("notification: tampering with any signed field is rejected", () => {
  const n = notif();
  for (const patch of [
    { payhere_amount: "1.00" }, { order_id: "order-2" }, { status_code: "0" },
    { payhere_currency: "USD" }, { merchant_id: "999" },
  ]) {
    assert.equal(verifyPayHereNotification({ ...n, ...patch }, SECRET), false, JSON.stringify(patch));
  }
});

test("notification: wrong secret, empty, short and garbage signatures rejected", () => {
  const n = notif();
  assert.equal(verifyPayHereNotification(n, "other-secret"), false);
  assert.equal(verifyPayHereNotification({ ...n, md5sig: "" }, SECRET), false);
  assert.equal(verifyPayHereNotification({ ...n, md5sig: "ABC" }, SECRET), false);
  assert.equal(verifyPayHereNotification({ ...n, md5sig: "Z".repeat(32) }, SECRET), false);
});

test("fingerprint: deterministic, order-independent, sensitive to changes", () => {
  const a = { x: "1", y: "2" };
  assert.equal(eventFingerprint(a), eventFingerprint({ y: "2", x: "1" }));
  assert.notEqual(eventFingerprint(a), eventFingerprint({ x: "1", y: "3" }));
  assert.match(eventFingerprint(a), /^[0-9a-f]{64}$/);
});

test("two legitimate installments have distinct fingerprints", () => {
  const f = (pid: string) =>
    eventFingerprint({ order_id: "o1", payment_id: pid, status_code: "2", message_type: "RECURRING_INSTALLMENT_SUCCESS" });
  assert.notEqual(f("p1"), f("p2"));
});

test("mapStatus: one-time codes", () => {
  assert.equal(mapStatus("ONE_TIME", undefined, "2"), "PAID");
  assert.equal(mapStatus("ONE_TIME", undefined, "0"), "PENDING");
  assert.equal(mapStatus("ONE_TIME", undefined, "-1"), "CANCELED");
  assert.equal(mapStatus("ONE_TIME", undefined, "-2"), "FAILED");
  assert.equal(mapStatus("ONE_TIME", undefined, "-3"), "CHARGEDBACK");
  assert.equal(mapStatus("ONE_TIME", undefined, "99"), "UNKNOWN");
});

test("mapStatus: subscription message types drive state", () => {
  assert.equal(mapStatus("SUBSCRIPTION", "AUTHORIZATION_SUCCESS", "2"), "ACTIVE");
  assert.equal(mapStatus("SUBSCRIPTION", "AUTHORIZATION_FAILED", "-2"), "FAILED");
  assert.equal(mapStatus("SUBSCRIPTION", "RECURRING_INSTALLMENT_SUCCESS", "2"), "ACTIVE");
  assert.equal(mapStatus("SUBSCRIPTION", "RECURRING_INSTALLMENT_FAILED", "-2"), "PAYMENT_FAILED");
  assert.equal(mapStatus("SUBSCRIPTION", "RECURRING_COMPLETE", "2"), "COMPLETED");
  assert.equal(mapStatus("SUBSCRIPTION", "RECURRING_STOPPED", "2"), "CANCELED");
  assert.equal(mapStatus("SUBSCRIPTION", "RECURRING_INSTALLMENT_SUCCESS", "-3"), "CHARGEDBACK");
});

test("isSameOrigin", () => {
  assert.equal(isSameOrigin("https://app.example.com", "https://app.example.com/x"), true);
  assert.equal(isSameOrigin("https://evil.example.com", "https://app.example.com"), false);
  assert.equal(isSameOrigin("http://app.example.com", "https://app.example.com"), false);
  assert.equal(isSameOrigin(null, "https://app.example.com"), false);
  assert.equal(isSameOrigin("not a url", "https://app.example.com"), false);
});

test("clientIp prefers first x-forwarded-for hop", () => {
  const h = (m: Record<string, string>) => ({ get: (k: string) => m[k] ?? null });
  assert.equal(clientIp(h({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })), "1.2.3.4");
  assert.equal(clientIp(h({ "x-real-ip": "9.9.9.9" })), "9.9.9.9");
  assert.equal(clientIp(h({})), "unknown");
});

test("logger redacts secrets, including nested", () => {
  const out = redact({ order_id: "o1", merchant_secret: "s", nested: { md5sig: "abc", ok: 1 }, list: [{ password: "p" }] }) as any;
  assert.equal(out.order_id, "o1");
  assert.equal(out.merchant_secret, "[REDACTED]");
  assert.equal(out.nested.md5sig, "[REDACTED]");
  assert.equal(out.nested.ok, 1);
  assert.equal(out.list[0].password, "[REDACTED]");
});

test("md5Upper is uppercase hex and matches the RFC 1321 vector", () => {
  assert.match(md5Upper("abc"), /^[0-9A-F]{32}$/);
  assert.equal(md5Upper("abc"), "900150983CD24FB0D6963F7D28E17F72");
});
