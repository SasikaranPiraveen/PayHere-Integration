import type { OrderKind } from "@/lib/payhere/status";

export type Product = {
  sku: string;
  name: string;
  kind: OrderKind;
  amountMinor: number; // the SERVER decides the price, never the browser
  currency: "LKR";
  recurrence?: string;
  duration?: string;
};

export const PRODUCTS: Record<string, Product> = {
  "starter-license": { sku: "starter-license", name: "Starter License", kind: "ONE_TIME", amountMinor: 250_000, currency: "LKR" },
  "pro-license": { sku: "pro-license", name: "Pro License", kind: "ONE_TIME", amountMinor: 750_000, currency: "LKR" },
  "saas-monthly": {
    sku: "saas-monthly", name: "SaaS Pro (monthly)", kind: "SUBSCRIPTION",
    amountMinor: 150_000, currency: "LKR", recurrence: "1 Month", duration: "Forever",
  },
};

export function getProduct(sku: string): Product | undefined {
  return Object.prototype.hasOwnProperty.call(PRODUCTS, sku) ? PRODUCTS[sku] : undefined;
}
