"use client";

import Script from "next/script";
import Link from "next/link";
import { useState } from "react";

declare global {
  interface Window {
    payhere?: {
      startPayment(payment: Record<string, unknown>): void;
      onCompleted?: (orderId: string) => void;
      onDismissed?: () => void;
      onError?: (error: string) => void;
    };
  }
}

type Item = { sku: string; name: string; price: string; kind: string };

export function CatalogClient({ items }: { items: Item[] }) {
  const [phone, setPhone] = useState("0771234567");
  const [address, setAddress] = useState("1 Example Road");
  const [city, setCity] = useState("Colombo");
  const [termsAccepted, setTermsAccepted] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!phone || !/^[0-9+\-\s]{7,20}$/.test(phone.trim())) {
      errs.phone = "Please enter a valid phone number (e.g. 0771234567).";
    }
    if (!address || address.trim().length < 3) {
      errs.address = "Please enter a valid delivery or billing address.";
    }
    if (!city || city.trim().length < 2) {
      errs.city = "Please enter your city.";
    }
    if (!termsAccepted) {
      errs.terms = "You must accept the Terms of Service and Refund Policy to proceed.";
    }
    setValidationErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function pay(sku: string) {
    if (!validate()) return;
    setBusy(sku);
    setError(null);

    // Client idempotency key to prevent accidental duplicate charge initiation
    const idempotencyKey = `idem_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    try {
      const res = await fetch("/api/payhere/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        credentials: "same-origin",
        body: JSON.stringify({
          sku,
          phone: phone.trim(),
          address: address.trim(),
          city: city.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Checkout initiation failed");

      // Verify PayHere JS SDK loaded
      const sdk = window.payhere;
      if (!sdk) {
        throw new Error("PayHere secure payment library is still loading. Please retry in a few seconds.");
      }

      // Wire SDK callbacks
      // IMPORTANT: In official payhere-2.0.js, popup mode requires return_url & cancel_url to be undefined in startPayment
      sdk.onCompleted = (orderId: string) => {
        // NOTE: onCompleted fires when user finishes PayHere modal;
        // The return URL loads read-only server status. It is NOT self-declared success.
        window.location.assign(data.returnUrl);
      };

      sdk.onDismissed = () => {
        window.location.assign(data.cancelUrl);
      };

      sdk.onError = (msg: string) => {
        setError(`Payment error: ${msg}`);
        setBusy(null);
      };

      const paymentConfig: Record<string, unknown> = {
        sandbox: data.sandbox,
        ...data.payment,
        return_url: undefined, // Mandatory for payhere-2.0.js popup mode
        cancel_url: undefined, // Mandatory for payhere-2.0.js popup mode
      };

      sdk.startPayment(paymentConfig);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to initiate payment");
      setBusy(null);
    }
  }

  return (
    <>
      {/* Official PayHere JavaScript SDK v2.0 */}
      <Script src="https://www.payhere.lk/lib/payhere-2.0.js" strategy="afterInteractive" />

      <div className="card">
        <strong>Billing &amp; Customer Details</strong> <span className="muted">(required by payment gateway)</span>
        
        <label>
          Phone Number:
          <input
            type="tel"
            value={phone}
            aria-invalid={!!validationErrors.phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </label>
        {validationErrors.phone && <p className="err" style={{ fontSize: "0.85rem", margin: "2px 0 8px" }}>{validationErrors.phone}</p>}

        <label>
          Address:
          <input
            type="text"
            value={address}
            aria-invalid={!!validationErrors.address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </label>
        {validationErrors.address && <p className="err" style={{ fontSize: "0.85rem", margin: "2px 0 8px" }}>{validationErrors.address}</p>}

        <label>
          City:
          <input
            type="text"
            value={city}
            aria-invalid={!!validationErrors.city}
            onChange={(e) => setCity(e.target.value)}
          />
        </label>
        {validationErrors.city && <p className="err" style={{ fontSize: "0.85rem", margin: "2px 0 8px" }}>{validationErrors.city}</p>}

        <div style={{ marginTop: "12px" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={(e) => setTermsAccepted(e.target.checked)}
            />
            <span style={{ fontSize: "0.9rem" }}>
              I agree to the <Link href="/terms" target="_blank">Terms of Service</Link>, <Link href="/privacy" target="_blank">Privacy Policy</Link>, and <Link href="/refund-policy" target="_blank">Refund Policy</Link>.
            </span>
          </label>
          {validationErrors.terms && <p className="err" style={{ fontSize: "0.85rem", margin: "4px 0" }}>{validationErrors.terms}</p>}
        </div>
      </div>

      {error && <p className="err" role="alert">{error}</p>}

      <div className="grid">
        {items.map((p) => (
          <div className="card" key={p.sku}>
            <strong>{p.name}</strong>
            <div className="muted">{p.kind === "SUBSCRIPTION" ? "Recurring Subscription" : "One-Time Payment"}</div>
            <p style={{ fontSize: "1.25rem", fontWeight: "bold", margin: "10px 0" }}>{p.price}</p>
            <button
              disabled={busy !== null}
              onClick={() => void pay(p.sku)}
              aria-busy={busy === p.sku}
            >
              {busy === p.sku ? "Opening PayHere…" : "Pay Securely with PayHere"}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
