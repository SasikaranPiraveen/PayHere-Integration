import Link from "next/link";

export default function Home() {
  return (
    <>
      <h1>Secure payments</h1>
      <p className="muted">One-time purchases and subscriptions, processed securely by PayHere.</p>
      <div className="card">
        <p><strong>Rule of this system:</strong> the browser redirect is never proof of payment. Only a signature-verified server callback changes an order to PAID.</p>
        <p className="row">
          <Link href="/catalog"><button>Open catalog</button></Link>
          <Link href="/admin"><button className="secondary">Admin console</button></Link>
        </p>
      </div>
    </>
  );
}
