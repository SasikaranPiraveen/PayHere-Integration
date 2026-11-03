/**
 * Standard customer-facing message catalog.
 * Follows Section 3.4 of the PayHere Production Implementation Handbook.
 * 
 * Safety Rule:
 * Messages must accurately reflect server-verified facts and NEVER promise
 * "no payment was taken" or "payment successful" based solely on browser navigation,
 * timeouts, or unconfirmed gateway callbacks.
 */

export const CUSTOMER_MESSAGES = {
  CHECKOUT_PREPARING: "Preparing your secure payment session…",
  CHECKOUT_REDIRECTING: "Opening PayHere secure payment window…",
  VERIFYING: "We’re verifying your payment with the gateway. Please do not close this window or pay again until we confirm the result.",
  PAID: "Payment confirmed. Thank you for your order!",
  FULFILLMENT_PENDING: "Payment confirmed. We’re preparing your order delivery.",
  FULFILLED: "Order fulfilled successfully. Your license or access is ready.",
  FAILED_VERIFIED: "The payment was unsuccessful or declined by your card issuer. You can retry when your order shows it is safe to do so.",
  CANCELLED_VERIFIED: "This payment attempt was cancelled. If you believe a charge occurred, please wait for verification before retrying.",
  UNKNOWN: "We couldn’t confirm the result immediately. Your payment is being verified in the background. Please check back shortly.",
  NETWORK_OFFLINE: "Your connection was interrupted. We will check whether a payment was processed as soon as you reconnect.",
  DUPLICATE_ATTEMPT: "A payment attempt is already in progress for this order. Please view its current status before starting another.",
  AMOUNT_CHANGED: "Your total or pricing has changed. Please review the updated amount before proceeding to pay.",
  REFUND_PENDING: "Your refund request is being processed. The status will update once confirmed by the bank.",
  REVIEW_REQUIRED: "We are reviewing a payment anomaly. Please contact customer support with your order reference.",
} as const;

export type CustomerMessageCode = keyof typeof CUSTOMER_MESSAGES;

export function getCustomerMessage(code: string | undefined): string {
  if (code && code in CUSTOMER_MESSAGES) {
    return CUSTOMER_MESSAGES[code as CustomerMessageCode];
  }
  return CUSTOMER_MESSAGES.VERIFYING;
}

