import Link from "next/link";

export default function TermsPage() {
  return (
    <div style={{ maxWidth: "800px", margin: "0 auto", padding: "20px 0" }}>
      <h1>Terms of Service</h1>
      <p className="muted">Last updated: November 2026</p>

      <div className="card" style={{ marginTop: "20px", lineHeight: "1.6" }}>
        <h3>1. Overview &amp; Acceptance</h3>
        <p>
          By accessing or purchasing software licenses and services through this application, you agree to be bound
          by these Terms of Service and all applicable laws and regulations of Sri Lanka.
        </p>

        <h3>2. Payment Processing</h3>
        <p>
          All online payments are securely processed through PayHere (Pvt) Ltd (licensed by the Central Bank of Sri Lanka).
          We never collect, store, or transmit your sensitive credit/debit card numbers (PAN) or card verification values (CVV).
          Card details are submitted directly to PayHere’s PCI-DSS compliant secure infrastructure.
        </p>

        <h3>3. Pricing &amp; Currency</h3>
        <p>
          All product prices are quoted in Sri Lankan Rupees (LKR) unless explicitly designated otherwise.
          Prices are computed authoritatively on our servers at the time of checkout quote creation.
        </p>

        <h3>4. Subscriptions &amp; Recurring Billing</h3>
        <p>
          Subscription products are billed on a recurring monthly basis. You authorize recurring charges to your payment method
          until you explicitly cancel your subscription via your account console. Cancellation takes effect at the end of the current billing cycle.
        </p>

        <h3>5. Governing Law</h3>
        <p>
          These terms shall be governed by and construed in accordance with the laws of Sri Lanka.
        </p>

        <p style={{ marginTop: "20px" }}>
          <Link href="/catalog">← Return to Catalog</Link>
        </p>
      </div>
    </div>
  );
}

