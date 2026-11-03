"use client";

import Link from "next/link";
import { useEffect, useState, useRef } from "react";
import { getCustomerMessage } from "@/lib/constants/messages";

type StatusResponse = {
  order_id: string;
  attempt_id: string | null;
  payment_state: string;
  fulfillment_state: string;
  amount_minor: number;
  currency: string;
  display_message_code: string;
  can_retry: boolean;
};

export function StatusPoller({ orderId, initialStatus }: { orderId: string; initialStatus: string }) {
  const [paymentState, setPaymentState] = useState(initialStatus);
  const [fulfillmentState, setFulfillmentState] = useState("NOT_READY");
  const [messageCode, setMessageCode] = useState(initialStatus === "PENDING" ? "VERIFYING" : initialStatus);
  const [canRetry, setCanRetry] = useState(false);
  const [pollingActive, setPollingActive] = useState(initialStatus === "PENDING");
  const [isRefreshing, setIsRefreshing] = useState(false);

  const pollCountRef = useRef(0);
  const timeoutIdRef = useRef<NodeJS.Timeout | null>(null);

  async function checkStatus() {
    try {
      setIsRefreshing(true);
      const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`, {
        cache: "no-store",
        headers: { "Pragma": "no-cache" },
      });

      if (res.ok) {
        const data = (await res.json()) as StatusResponse;
        setPaymentState(data.payment_state);
        setFulfillmentState(data.fulfillment_state);
        setMessageCode(data.display_message_code);
        setCanRetry(data.can_retry);

        // Terminal states stop polling
        if (data.payment_state !== "PENDING") {
          setPollingActive(false);
          return true;
        }
      }
    } catch {
      // Transient network hiccup during poll; keep polling boundedly
    } finally {
      setIsRefreshing(false);
    }
    return false;
  }

  useEffect(() => {
    if (!pollingActive) return;

    function scheduleNextPoll() {
      pollCountRef.current += 1;
      // Maximum interactive polling window (~60 seconds: 12 attempts with backoff)
      if (pollCountRef.current > 12) {
        setPollingActive(false);
        setMessageCode("UNKNOWN");
        return;
      }

      // Exponential backoff with jitter: 2000ms -> 3000ms -> 4500ms ... capped at 8000ms
      const baseDelay = Math.min(2000 * Math.pow(1.3, pollCountRef.current), 8000);
      const jitter = Math.floor(Math.random() * 500);
      const delay = baseDelay + jitter;

      timeoutIdRef.current = setTimeout(async () => {
        const isTerminal = await checkStatus();
        if (!isTerminal && pollingActive) {
          scheduleNextPoll();
        }
      }, delay);
    }

    scheduleNextPoll();

    return () => {
      if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);
    };
  }, [orderId, pollingActive]);

  const customerMessage = getCustomerMessage(messageCode);

  return (
    <div className="card" role="region" aria-live="polite">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <strong>Payment Status:</strong>
        <span className={`badge ${paymentState}`}>{paymentState}</span>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <strong>Fulfillment:</strong>
        <span className={`badge ${fulfillmentState}`}>{fulfillmentState}</span>
      </div>

      <p style={{ lineHeight: "1.5", margin: "12px 0" }}>{customerMessage}</p>

      {pollingActive && (
        <p className="muted" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span>Communicating with PayHere…</span>
        </p>
      )}

      <div className="row" style={{ marginTop: "20px", gap: "10px" }}>
        <button
          className="secondary"
          onClick={() => void checkStatus()}
          disabled={isRefreshing}
        >
          {isRefreshing ? "Checking…" : "Refresh Status"}
        </button>

        <Link href="/orders">
          <button className="secondary">View My Orders</button>
        </Link>

        {canRetry && (
          <Link href="/catalog">
            <button>Try Payment Again</button>
          </Link>
        )}
      </div>

      <p className="muted" style={{ fontSize: "0.8rem", marginTop: "16px" }}>
        Order Reference: <code>{orderId}</code>
      </p>
    </div>
  );
}
