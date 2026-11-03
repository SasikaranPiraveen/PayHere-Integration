import { PRODUCTS } from "@/lib/products";
import { money } from "@/lib/format";
import { env } from "@/lib/env";
import { CatalogClient } from "./CatalogClient";

export default function CatalogPage() {
  const items = Object.values(PRODUCTS).map((p) => ({
    sku: p.sku,
    name: p.name,
    kind: p.kind,
    price: money(p.amountMinor, p.currency) + (p.kind === "SUBSCRIPTION" ? " / month" : ""),
  }));
  return (
    <>
      <h1>Catalog</h1>
      {env().PAYHERE_MODE === "sandbox" && (
        <p className="muted">Sandbox mode. Use PayHere test cards; no real money moves.</p>
      )}
      <CatalogClient items={items} />
    </>
  );
}
