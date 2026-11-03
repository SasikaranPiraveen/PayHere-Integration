"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function AdminRefundForm() {
  const router = useRouter();
  const [orderId, setOrderId] = useState("");
  const [reason, setReason] = useState("Customer requested cancellation");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  async function handleRefund(e: React.FormEvent) {
    e.preventDefault();
    if (!orderId) return;

    setBusy(true);
    setStatus(null);

    try {
      const res = await fetch("/api/admin/refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ orderId: orderId.trim(), reason: reason.trim() }),
      });

      const data = await res.json();
      if (res.ok) {
        setStatus({ ok: true, msg: `Refund successful! PayHere Refund ID: ${data.providerRefundId}` });
        setOrderId("");
        router.refresh();
      } else {
        setStatus({ ok: false, msg: data.error ?? "Refund failed" });
      }
    } catch (err) {
      setStatus({ ok: false, msg: "Network error during refund submission" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: "20px" }}>
      <h3>Issue PayHere Refund (Admin)</h3>
      <form onSubmit={handleRefund}>
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ flex: "1 1 200px" }}>
            Order ID:
            <input
              type="text"
              placeholder="e.g. ord_..."
              value={orderId}
              onChange={(e) => setOrderId(e.target.value)}
              required
            />
          </label>
          <label style={{ flex: "2 1 300px" }}>
            Reason:
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
            />
          </label>
          <button type="submit" disabled={busy || !orderId}>
            {busy ? "Processing…" : "Submit Refund"}
          </button>
        </div>
      </form>
      {status && (
        <p className={status.ok ? "badge PAID" : "err"} style={{ marginTop: "10px" }}>
          {status.msg}
        </p>
      )}
    </div>
  );
}

