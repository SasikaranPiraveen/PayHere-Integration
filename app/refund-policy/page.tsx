import Link from "next/link";

export default function RefundPolicyPage() {
  return (
    <div style={{ maxWidth: "800px", margin: "0 auto", padding: "20px 0" }}>
      <h1>Refund &amp; Cancellation Policy</h1>
      <p className="muted">Last updated: November 2026</p>

      <div className="card" style={{ marginTop: "20px", lineHeight: "1.6" }}>
        <h3>1. Refund Eligibility</h3>
        <p>
          We want you to be completely satisfied with your purchase. If you experience technical defects
          or service unavailability that cannot be resolved within 7 business days, you are entitled to a full or partial refund.
        </p>

        <h3>2. Requesting a Refund</h3>
        <p>
          To request a refund, contact our support team with your order reference number and reason for the request.
          Refund requests are reviewed by our finance team and processed directly through the PayHere Refund API to your original payment method.
        </p>

        <h3>3. Processing Timeline</h3>
        <p>
          Once approved, refunds are transmitted to PayHere immediately. Depending on your issuing bank, the credit
          typically appears on your card statement within 3 to 10 business days.
        </p>

        <h3>4. Subscription Cancellations</h3>
        <p>
          You may cancel recurring subscriptions at any time via your account dashboard. Upon cancellation,
          no further recurring charges will be initiated, and your access will remain active until the end of the current billing period.
        </p>

        <p style={{ marginTop: "20px" }}>
          <Link href="/catalog">← Return to Catalog</Link>
        </p>
      </div>
    </div>
  );
}

