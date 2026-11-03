import { db } from "@/lib/supabase";
import { getAdminId } from "@/lib/guards";
import { money } from "@/lib/format";
import { AdminRefundForm } from "./AdminRefundForm";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const adminId = await getAdminId();
  if (!adminId) {
    return (
      <>
        <h1>Admin</h1>
        <p className="err">Forbidden. Add your Clerk user id to ADMIN_USER_IDS (or set publicMetadata role=admin).</p>
      </>
    );
  }

  const [orders, ledger, hooks, outbox, refunds] = await Promise.all([
    db().from("payment_orders").select("order_id, kind, amount_minor, currency, status, user_id, created_at").order("created_at", { ascending: false }).limit(15),
    db().from("ledger_entries").select("id, order_id, entry_type, amount_minor, currency, provider_payment_id, created_at").order("id", { ascending: false }).limit(15),
    db().from("webhook_log").select("id, received_at, order_id, result, message_type, status_code, latency_ms, ip").order("id", { ascending: false }).limit(15),
    db().from("outbox_events").select("id, aggregate_id, event_type, status, attempts, next_retry_at, created_at").order("id", { ascending: false }).limit(10),
    db().from("refund_operations").select("id, order_id, amount_minor, currency, status, provider_refund_id, requested_by, created_at").order("id", { ascending: false }).limit(10),
  ]);

  return (
    <>
      <h1>Admin Console &amp; Operations</h1>

      <AdminRefundForm />

      <h2>Transactional Outbox Queue</h2>
      {(!outbox.data || outbox.data.length === 0) ? (
        <p className="muted">No outbox events queued.</p>
      ) : (
        <table>
          <thead><tr><th>#</th><th>Order</th><th>Event</th><th>Status</th><th>Tries</th><th>Next Retry</th></tr></thead>
          <tbody>
            {outbox.data.map((evt) => (
              <tr key={evt.id}>
                <td>{evt.id}</td>
                <td>{evt.aggregate_id.slice(0, 8)}</td>
                <td><code>{evt.event_type}</code></td>
                <td><span className={`badge ${evt.status}`}>{evt.status}</span></td>
                <td>{evt.attempts}</td>
                <td className="muted">{new Date(evt.next_retry_at).toLocaleTimeString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Refund Operations</h2>
      {(!refunds.data || refunds.data.length === 0) ? (
        <p className="muted">No refund operations recorded.</p>
      ) : (
        <table>
          <thead><tr><th>#</th><th>Order</th><th>Amount</th><th>Status</th><th>Refund Ref</th><th>Requested By</th></tr></thead>
          <tbody>
            {refunds.data.map((rf) => (
              <tr key={rf.id}>
                <td>{rf.id}</td>
                <td>{rf.order_id.slice(0, 8)}</td>
                <td>{money(rf.amount_minor, rf.currency)}</td>
                <td><span className={`badge ${rf.status}`}>{rf.status}</span></td>
                <td><code>{rf.provider_refund_id ?? "-"}</code></td>
                <td className="muted">{rf.requested_by.slice(0, 10)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Webhook Inspector</h2>
      <table>
        <thead><tr><th>Time</th><th>Order</th><th>Result</th><th>Type</th><th>Code</th><th>ms</th><th>IP</th></tr></thead>
        <tbody>
          {(hooks.data ?? []).map((h) => (
            <tr key={h.id}>
              <td className="muted">{new Date(h.received_at).toLocaleTimeString()}</td>
              <td>{h.order_id?.slice(0, 8) ?? "-"}</td>
              <td><span className={`badge ${h.result}`}>{h.result}</span></td>
              <td>{h.message_type ?? "-"}</td><td>{h.status_code ?? "-"}</td><td>{h.latency_ms}</td><td>{h.ip}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Financial Ledger (Append-Only)</h2>
      <table>
        <thead><tr><th>#</th><th>Order</th><th>Type</th><th>Amount</th><th>Provider Ref</th></tr></thead>
        <tbody>
          {(ledger.data ?? []).map((l) => (
            <tr key={l.id}>
              <td>{l.id}</td>
              <td>{l.order_id.slice(0, 8)}</td>
              <td><strong>{l.entry_type}</strong></td>
              <td>{money(l.amount_minor, l.currency)}</td>
              <td><code>{l.provider_payment_id ?? "-"}</code></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Recent Orders</h2>
      <table>
        <thead><tr><th>Order</th><th>Kind</th><th>Amount</th><th>Status</th><th>User</th></tr></thead>
        <tbody>
          {(orders.data ?? []).map((o) => (
            <tr key={o.order_id}>
              <td>{o.order_id.slice(0, 8)}</td><td>{o.kind}</td><td>{money(o.amount_minor, o.currency)}</td>
              <td><span className={`badge ${o.status}`}>{o.status}</span></td><td className="muted">{o.user_id.slice(0, 12)}…</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
