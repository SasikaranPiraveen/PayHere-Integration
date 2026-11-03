import Link from "next/link";

export default async function CancelPage({ searchParams }: { searchParams: Promise<{ orderId?: string }> }) {
  const { orderId } = await searchParams;

  return (
    <>
      <h1>Payment Cancelled</h1>
      <div className="card">
        <p style={{ lineHeight: "1.5" }}>
          This payment checkout attempt was cancelled or closed before processing was finalized.
        </p>
        <p className="muted" style={{ fontSize: "0.9rem", marginTop: "8px" }}>
          <strong>Important security notice:</strong> Navigating away or closing the payment window does not automatically guarantee no payment moved if card details were already submitted. If a charge was processed by your bank, our system will automatically record it via verified gateway notification.
        </p>

        {orderId && (
          <p className="muted" style={{ fontSize: "0.85rem", marginTop: "12px" }}>
            Order Reference: <code>{orderId}</code>
          </p>
        )}

        <div className="row" style={{ marginTop: "16px", gap: "10px" }}>
          {orderId && (
            <Link href={`/payment/return?orderId=${encodeURIComponent(orderId)}`}>
              <button className="secondary">Check Order Status</button>
            </Link>
          )}
          <Link href="/catalog">
            <button>Return to Catalog</button>
          </Link>
        </div>
      </div>
    </>
  );
}
