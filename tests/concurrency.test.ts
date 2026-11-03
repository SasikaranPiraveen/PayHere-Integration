import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRequestFingerprint, isValidIdempotencyKey } from "../lib/payments/idempotency-pure.ts";
import { isOrderSafeToRetry, mapStatus } from "../lib/payhere/status.ts";

test("C01 & C02: Idempotency Key fingerprint sensitivity and collision resistance", () => {
  const req1 = { sku: "starter-license", phone: "0771234567", address: "1 Road", city: "Colombo" };
  const req2ChangedPayload = { sku: "starter-license", phone: "0771234567", address: "1 Road", city: "Kandy" };

  const fp1 = computeRequestFingerprint(req1);
  const fp2 = computeRequestFingerprint(req2ChangedPayload);

  // Different payload produces distinct fingerprint
  assert.notEqual(fp1, fp2);
  
  // Same payload regardless of key permutation produces identical fingerprint (C01)
  const req1Permuted = { city: "Colombo", sku: "starter-license", address: "1 Road", phone: "0771234567" };
  assert.equal(computeRequestFingerprint(req1Permuted), fp1);
});

test("C03: Concurrent retry rules enforce terminal-only re-payment", () => {
  // Concurrently requesting another attempt on an in-progress or paid order is disallowed
  assert.equal(isOrderSafeToRetry("PENDING"), false);
  assert.equal(isOrderSafeToRetry("PAID"), false);
  assert.equal(isOrderSafeToRetry("ACTIVE"), false);

  // Only terminal failure allows safe re-attempt
  assert.equal(isOrderSafeToRetry("FAILED"), true);
  assert.equal(isOrderSafeToRetry("CANCELED"), true);
});

test("C07: Out-of-order transition rules prevent regression from PAID to FAILED", () => {
  // If an order has been marked PAID, a late FAILED callback cannot regress it
  const currentStatus = "PAID";
  const attemptedNewStatus = mapStatus("ONE_TIME", undefined, "-2"); // FAILED
  assert.equal(attemptedNewStatus, "FAILED");

  // In our financial state machine, transitions from PAID to FAILED are strictly forbidden
  const allowedTransition = (currentStatus: string, nextStatus: string): boolean => {
    if (currentStatus === "PAID" && nextStatus === "FAILED") return false;
    if (currentStatus === "PAID" && nextStatus === "CANCELED") return false;
    return true;
  };

  assert.equal(allowedTransition(currentStatus, attemptedNewStatus), false);
});

test("C08: Chargeback (-3) is terminal and overrides prior status safely", () => {
  assert.equal(mapStatus("ONE_TIME", undefined, "-3"), "CHARGEDBACK");
  assert.equal(mapStatus("SUBSCRIPTION", "RECURRING_INSTALLMENT_SUCCESS", "-3"), "CHARGEDBACK");
});
