import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/supabase";
import { getUserId } from "@/lib/guards";
import { money } from "@/lib/format";
import { isOrderSafeToRetry } from "@/lib/payments/orders";

export const dynamic = "force-dynamic";

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const userId = await getUserId();
  if (!userId) return <p>Please sign in.</p>;

  const { id } = await params;
  if (!id) notFound();

  // 1. Fetch business order scoped by authenticated user
  const { data: order, error: orderErr } = await db()
    .from("payment_orders")
    .select("*")
    .eq("order_id", id)
    .eq("user_id", userId)
    .maybeSingle();

  if (orderErr || !order) notFound();

  // 2. Fetch payment attempts
  const { data: attempts } = await db()
    .from("payment_attempts")
    .select("attempt_id, provider_order_id, status, amount_minor, currency, attempt_number, created_at")
    .eq("order_id", id)
    .order("attempt_number", { ascending: false });

  // 3. Fetch financial ledger postings
  const { data: ledger } = await db()
    .from("ledger_entries")
    .select("id, entry_type, amount_minor, currency, provider_payment_id, created_at")
    .eq("order_id", id)
    .order("id", { ascending: true });

  // 4. Fetch fulfillment
  const { data: fulfillment } = await db()
    .from("fulfillments")
    .select("fulfilled_at")
    .eq("order_id", id)
    .maybeSingle();

  const canRetry = isOrderSafeToRetry(order.status);
  const isPaid = order.status === "PAID" || order.status === "ACTIVE";

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Order Details</h1>
        <Link href="/orders">
          <button className="secondary">← Back to Orders</button>
        </Link>
      </div>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <strong>{order.description}</strong>
          <span className={`badge ${order.status}`}>{order.status}</span>
        </div>

        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Order ID: <code>{order.order_id}</code> | Created: {new Date(order.created_at).toLocaleString()}
        </p>

        <p style={{ fontSize: "1.2rem", fontWeight: "bold", margin: "12px 0" }}>
          Total: {money(order.amount_minor, order.currency)}
        </p>

        <div style={{ margin: "16px 0", padding: "12px", background: "var(--bg-subtle, #f5f5f5)", borderRadius: "6px" }}>
          <strong>Fulfillment Status: </strong>
          <span className={`badge ${fulfillment ? "PAID" : "PENDING"}`}>
            {fulfillment ? "FULFILLED" : (isPaid ? "QUEUED FOR DELIVERY" : "NOT READY")}
          </span>
          {fulfillment && (
            <p className="muted" style={{ fontSize: "0.85rem", marginTop: "4px" }}>
              Fulfilled on: {new Date(fulfillment.fulfilled_at).toLocaleString()}
            </p>
          )}
        </div>

        {canRetry && (
          <div style={{ marginTop: "16px" }}>
            <Link href="/catalog">
              <button>Try Payment Again</button>
            </Link>
          </div>
        )}
      </div>

      <h2>Payment Attempts</h2>
      {(!attempts || attempts.length === 0) ? (
        <p className="muted">No detailed attempt history recorded for this order.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Gateway Order ID</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {attempts.map((att) => (
              <tr key={att.attempt_id}>
                <td>{att.attempt_number}</td>
                <td><code>{att.provider_order_id}</code></td>
                <td>{money(att.amount_minor, att.currency)}</td>
                <td><span className={`badge ${att.status}`}>{att.status}</span></td>
                <td className="muted">{new Date(att.created_at).toLocaleTimeString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Financial Ledger Entries (Immutable Audit)</h2>
      {(!ledger || ledger.length === 0) ? (
        <p className="muted">No ledger postings yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Entry Type</th>
              <th>Amount</th>
              <th>Provider Payment ID</th>
              <th>Posted At</th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((l) => (
              <tr key={l.id}>
                <td><strong>{l.entry_type}</strong></td>
                <td>{money(l.amount_minor, l.currency)}</td>
                <td><code>{l.provider_payment_id ?? "-"}</code></td>
                <td className="muted">{new Date(l.created_at).toLocaleTimeString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

