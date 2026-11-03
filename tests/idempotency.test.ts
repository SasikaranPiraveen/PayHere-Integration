import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRequestFingerprint, isValidIdempotencyKey } from "../lib/payments/idempotency-pure.ts";

test("isValidIdempotencyKey: validates key format and bounds", () => {
  assert.equal(isValidIdempotencyKey("idem_valid_key_12345"), true);
  assert.equal(isValidIdempotencyKey("12345678"), true);
  assert.equal(isValidIdempotencyKey("short"), false); // too short (<8)
  assert.equal(isValidIdempotencyKey(""), false);
  assert.equal(isValidIdempotencyKey(null), false);
  assert.equal(isValidIdempotencyKey(undefined), false);
  assert.equal(isValidIdempotencyKey("has spaces in key 1234"), false);
  assert.equal(isValidIdempotencyKey("special!@#$%^&*()"), false);
});

test("computeRequestFingerprint: deterministic regardless of key order", () => {
  const payload1 = { sku: "starter-license", phone: "0771234567", address: "1 Road", city: "Colombo" };
  const payload2 = { city: "Colombo", address: "1 Road", sku: "starter-license", phone: "0771234567" };
  
  const fp1 = computeRequestFingerprint(payload1);
  const fp2 = computeRequestFingerprint(payload2);
  
  assert.equal(fp1, fp2);
  assert.match(fp1, /^[0-9a-f]{64}$/);
});

test("computeRequestFingerprint: changes when any field value changes", () => {
  const base = { sku: "starter-license", phone: "0771234567" };
  const altered = { sku: "starter-license", phone: "0779999999" };
  
  assert.notEqual(computeRequestFingerprint(base), computeRequestFingerprint(altered));
});
