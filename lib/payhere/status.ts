// Maps PayHere callback fields to our internal order status. Pure and unit-tested.
export type OrderKind = "ONE_TIME" | "SUBSCRIPTION";
export type OrderStatus =
  | "PENDING" | "PAID" | "FAILED" | "CANCELED" | "CHARGEDBACK"
  | "ACTIVE" | "PAYMENT_FAILED" | "COMPLETED" | "UNKNOWN";

function oneTime(statusCode: string): OrderStatus {
  switch (statusCode) {
    case "2": return "PAID";
    case "0": return "PENDING";
    case "-1": return "CANCELED";
    case "-2": return "FAILED";
    case "-3": return "CHARGEDBACK";
    default: return "UNKNOWN";
  }
}

export function mapStatus(kind: OrderKind, messageType: string | undefined, statusCode: string): OrderStatus {
  if (statusCode === "-3") return "CHARGEDBACK";
  if (kind === "ONE_TIME") return oneTime(statusCode);
  switch (messageType) {
    case "AUTHORIZATION_SUCCESS": return "ACTIVE";
    case "AUTHORIZATION_FAILED": return "FAILED";
    case "RECURRING_INSTALLMENT_SUCCESS": return "ACTIVE";
    case "RECURRING_INSTALLMENT_FAILED": return "PAYMENT_FAILED";
    case "RECURRING_COMPLETE": return "COMPLETED";
    case "RECURRING_STOPPED": return "CANCELED";
    default: return oneTime(statusCode);
  }
}

/**
 * Determines whether an order is in a safe terminal state permitting retry.
 * Only FAILED and CANCELED orders may be retried without risking duplicate charges.
 */
export function isOrderSafeToRetry(status: string): boolean {
  return status === "FAILED" || status === "CANCELED";
}
