import { test } from "node:test";
import assert from "node:assert/strict";
import {
  notificationSignature, verifyPayHereNotification, type PayHereNotification,
} from "../lib/payhere/sign.ts";
import { mapStatus } from "../lib/payhere/status.ts";

const SECRET = "sample-merchant-secret-12345";

function buildNotification(over: Partial<PayHereNotification> = {}): PayHereNotification {
  const base: PayHereNotification = {
    merchant_id: "1210001",
    order_id: "ord_test_100",
    payment_id: "3200112233",
    payhere_amount: "1500.00",
    payhere_currency: "LKR",
    status_code: "2",
    md5sig: "",
  };
  const merged = { ...base, ...over };
  return {
    ...merged,
    md5sig: over.md5sig ?? notificationSignature(merged, SECRET),
  };
}

test("webhook: valid signature accepted", () => {
  const n = buildNotification();
  assert.equal(verifyPayHereNotification(n, SECRET), true);
  // Case-insensitive hex acceptance
  assert.equal(verifyPayHereNotification({ ...n, md5sig: n.md5sig.toLowerCase() }, SECRET), true);
});

test("webhook: non-hex characters rejected even if length is 32", () => {
  const n = buildNotification({ md5sig: "G".repeat(32) });
  assert.equal(verifyPayHereNotification(n, SECRET), false);
  const n2 = buildNotification({ md5sig: "Z1234567890123456789012345678901" });
  assert.equal(verifyPayHereNotification(n2, SECRET), false);
});

test("webhook: tampered signed fields always fail signature verification", () => {
  const valid = buildNotification();
  
  // Tampering with amount
  assert.equal(verifyPayHereNotification({ ...valid, payhere_amount: "1499.99" }, SECRET), false);
  // Tampering with currency
  assert.equal(verifyPayHereNotification({ ...valid, payhere_currency: "USD" }, SECRET), false);
  // Tampering with merchant_id
  assert.equal(verifyPayHereNotification({ ...valid, merchant_id: "9999999" }, SECRET), false);
  // Tampering with order_id
  assert.equal(verifyPayHereNotification({ ...valid, order_id: "ord_evil_200" }, SECRET), false);
  // Tampering with status_code
  assert.equal(verifyPayHereNotification({ ...valid, status_code: "0" }, SECRET), false);
});

test("webhook: unsigned fields do NOT alter md5sig (crucial architectural fact)", () => {
  // PayHere published formula does NOT include payment_id or message_type in md5sig.
  // This test proves that modifying unsigned fields retains a valid signature,
  // which is why the database layer MUST isolate provider_payment_id rather than trusting the signature alone.
  const n1 = buildNotification({ payment_id: "pay_1" });
  const n2 = buildNotification({ payment_id: "pay_2_tampered" });
  
  // Both have identical md5sig because payment_id is excluded from PayHere's formula
  assert.equal(n1.md5sig, n2.md5sig);
  assert.equal(verifyPayHereNotification(n2, SECRET), true);
});

test("mapStatus: financial transitions preserve terminal chargeback", () => {
  // Chargeback (-3) is terminal
  assert.equal(mapStatus("ONE_TIME", undefined, "-3"), "CHARGEDBACK");
  assert.equal(mapStatus("SUBSCRIPTION", "RECURRING_INSTALLMENT_SUCCESS", "-3"), "CHARGEDBACK");
});

test("mapStatus: subscription lifecycle events mapped accurately", () => {
  assert.equal(mapStatus("SUBSCRIPTION", "AUTHORIZATION_SUCCESS", "2"), "ACTIVE");
  assert.equal(mapStatus("SUBSCRIPTION", "RECURRING_INSTALLMENT_SUCCESS", "2"), "ACTIVE");
  assert.equal(mapStatus("SUBSCRIPTION", "RECURRING_INSTALLMENT_FAILED", "-2"), "PAYMENT_FAILED");
  assert.equal(mapStatus("SUBSCRIPTION", "RECURRING_COMPLETE", "2"), "COMPLETED");
  assert.equal(mapStatus("SUBSCRIPTION", "RECURRING_STOPPED", "2"), "CANCELED");
});

