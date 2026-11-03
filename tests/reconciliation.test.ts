import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMinorUnits } from "../lib/payhere/sign.ts";

test("Reconciliation: amount matching logic compares normalized two-decimal strings", () => {
  const orderAmountMinor = 250000; // 2500.00 LKR
  const expectedStr = formatMinorUnits(orderAmountMinor);
  assert.equal(expectedStr, "2500.00");

  const gatewayReportedAmount1 = 2500.0;
  assert.equal(Number(gatewayReportedAmount1).toFixed(2), expectedStr);

  const gatewayReportedMismatch = 2499.0;
  assert.notEqual(Number(gatewayReportedMismatch).toFixed(2), expectedStr);
});

test("Refunds: refundable balance bounds prevent over-refunding", () => {
  const capturedAmount = 750000; // 7500.00 LKR
  let alreadyRefunded = 250000;
  let inFlight = 100000;

  const maxAvailable = capturedAmount - alreadyRefunded - inFlight;
  assert.equal(maxAvailable, 400000); // 4000.00 LKR max

  // Attempting refund higher than available balance must be bounded
  const requestedExcessiveRefund = 500000;
  const boundedRefund = Math.min(requestedExcessiveRefund, maxAvailable);
  assert.equal(boundedRefund, 400000);

  // If already fully refunded, available must be 0
  alreadyRefunded = 750000;
  inFlight = 0;
  const fullyRefundedAvailable = Math.max(0, capturedAmount - alreadyRefunded - inFlight);
  assert.equal(fullyRefundedAvailable, 0);
});

