import Link from "next/link";

export default function PrivacyPage() {
  return (
    <div style={{ maxWidth: "800px", margin: "0 auto", padding: "20px 0" }}>
      <h1>Privacy Policy</h1>
      <p className="muted">Last updated: November 2026</p>

      <div className="card" style={{ marginTop: "20px", lineHeight: "1.6" }}>
        <h3>1. Information We Collect</h3>
        <p>
          We collect your name, email address, phone number, and billing/shipping address solely for the purpose of
          order fulfillment, customer support, and mandatory transaction records.
        </p>

        <h3>2. Cardholder Data Protection</h3>
        <p>
          We do <strong>not</strong> collect, process, or store payment card numbers, card expiry dates, or CVV codes.
          All payment card input fields are hosted within secure PayHere iframes or hosted payment pages.
        </p>

        <h3>3. Data Sharing &amp; Third Parties</h3>
        <p>
          Customer data is shared only with:
        </p>
        <ul>
          <li><strong>PayHere (Pvt) Ltd:</strong> To authorize and process payments, manage subscriptions, and process authorized refunds.</li>
          <li><strong>Clerk:</strong> For identity verification and customer account security.</li>
        </ul>

        <h3>4. Security Measures</h3>
        <p>
          All web traffic is encrypted using TLS 1.3/HTTPS. Administrative operations require role-based access control,
          and internal database tables are protected by strict PostgreSQL Row Level Security (RLS).
        </p>

        <p style={{ marginTop: "20px" }}>
          <Link href="/catalog">← Return to Catalog</Link>
        </p>
      </div>
    </div>
  );
}

