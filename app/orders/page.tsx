import Link from "next/link";
import { db } from "@/lib/supabase";
import { getUserId } from "@/lib/guards";
import { money } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const userId = await getUserId();
  if (!userId) return <p>Please sign in.</p>;

  const { data, error } = await db()
    .from("payment_orders")
    .select("order_id, description, kind, amount_minor, currency, status, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return <p className="err">Could not load orders.</p>;
  const rows = data ?? [];

  return (
    <>
      <h1>My Orders</h1>
      {rows.length === 0 ? (
        <p className="muted">No orders found.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Type</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Created</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.order_id}>
                <td>{o.description}</td>
                <td>{o.kind}</td>
                <td>{money(o.amount_minor, o.currency)}</td>
                <td><span className={`badge ${o.status}`}>{o.status}</span></td>
                <td className="muted">{new Date(o.created_at).toLocaleString()}</td>
                <td>
                  <Link href={`/orders/${encodeURIComponent(o.order_id)}`}>
                    <button className="secondary" style={{ padding: "4px 8px", fontSize: "0.85rem" }}>
                      Details
                    </button>
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
