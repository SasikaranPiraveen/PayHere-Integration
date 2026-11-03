import "server-only";
import { env, merchantApiCredentials } from "@/lib/env";
import { log } from "@/lib/logger";

export type PayHereSearchResult = {
  payment_id: string;
  order_id: string;
  date: string;
  status: "RECEIVED" | "REFUND REQUESTED" | "REFUND PROCESSING" | "REFUNDED" | "CHARGEBACKED";
  currency: string;
  amount: number;
  gross?: number;
  fee?: number;
  net?: number;
};

export type PayHereRetrievalResponse = {
  status: 1 | 0 | -1 | -2;
  msg: string;
  data: PayHereSearchResult[] | null;
};

export type PayHereRefundResponse = {
  status: 1 | 0 | -1;
  msg: string;
  data: number | string | null; // Unique refund number from PayHere
};

// Rate limiter state: PayHere allows max 20 requests per 10 seconds across /merchant/v1/
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 10000;
const requestTimestamps: number[] = [];

// Token cache state
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

/**
 * Enforces the strict PayHere Merchant API rate limit of 20 requests per 10 seconds.
 */
async function enforceRateLimit(): Promise<void> {
  const now = Date.now();
  // Clear timestamps older than 10 seconds
  while (requestTimestamps.length > 0 && requestTimestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
    requestTimestamps.shift();
  }

  if (requestTimestamps.length >= RATE_LIMIT_MAX) {
    const oldest = requestTimestamps[0];
    const waitTime = oldest + RATE_LIMIT_WINDOW_MS - now + 50;
    log("warn", "payhere_merchant_api_throttling", { waitTimeMs: waitTime });
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  requestTimestamps.push(Date.now());
}

/**
 * PayHere Merchant API Base URL.
 */
export function getMerchantApiBase(): string {
  return env().PAYHERE_MODE === "live" ? "https://www.payhere.lk" : "https://sandbox.payhere.lk";
}

/**
 * Retrieves an OAuth 2.0 Bearer access token for PayHere Merchant APIs.
 */
export async function getPayHereAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && tokenExpiresAt > now + 60000) {
    return cachedToken;
  }

  const creds = merchantApiCredentials();
  await enforceRateLimit();

  const authCode = Buffer.from(`${creds.appId}:${creds.appSecret}`).toString("base64");
  const tokenUrl = `${getMerchantApiBase()}/merchant/v1/oauth/token`;

  try {
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${authCode}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    if (!res.ok) {
      const errText = await res.text();
      log("error", "payhere_token_exchange_failed", { status: res.status, errText });
      throw new Error(`PayHere OAuth token error: ${res.status}`);
    }

    const data = await res.json();
    cachedToken = data.access_token;
    tokenExpiresAt = now + (Number(data.expires_in) || 600) * 1000;
    return cachedToken!;
  } catch (e) {
    log("error", "payhere_token_fetch_threw", { error: String(e) });
    throw e;
  }
}

/**
 * Queries the PayHere Retrieval API for payment details by order_id.
 * Documentation: https://support.payhere.lk/api-&-mobile-sdk/retrieval-api
 */
export async function searchPayHerePayment(orderId: string): Promise<PayHereRetrievalResponse> {
  await enforceRateLimit();
  const token = await getPayHereAccessToken();
  const url = `${getMerchantApiBase()}/merchant/v1/payment/search?order_id=${encodeURIComponent(orderId)}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      log("warn", "payhere_retrieval_request_failed", { orderId, status: res.status });
      return { status: -1, msg: `HTTP error: ${res.status}`, data: null };
    }

    const json = (await res.json()) as PayHereRetrievalResponse;
    return json;
  } catch (e) {
    log("error", "payhere_retrieval_exception", { orderId, error: String(e) });
    return { status: -1, msg: "Network error", data: null };
  }
}

/**
 * Submits a refund request via PayHere Refund API.
 * Documentation: https://support.payhere.lk/api-&-mobile-sdk/refund-api
 */
export async function submitPayHereRefund(
  paymentId: string,
  description: string,
  amount?: string,
): Promise<PayHereRefundResponse> {
  // Token failure means the refund was never sent, so it is a definite FAILED (-1), not UNKNOWN.
  let token: string;
  try {
    token = await getPayHereAccessToken();
  } catch (e) {
    return { status: -1, msg: `Merchant API auth failed: ${e instanceof Error ? e.message : String(e)}`, data: null };
  }
  await enforceRateLimit();
  const url = `${getMerchantApiBase()}/merchant/v1/payment/refund`;

  const body: Record<string, string> = {
    payment_id: paymentId,
    description: description.slice(0, 200),
  };
  if (amount) {
    body.amount = amount;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      log("error", "payhere_refund_api_error", { paymentId, status: res.status, errText });
      return { status: -1, msg: `HTTP error: ${res.status}`, data: null };
    }

    const data = (await res.json()) as PayHereRefundResponse;
    return data;
  } catch (e) {
    log("error", "payhere_refund_exception", { paymentId, error: String(e) });
    return { status: 0, msg: "Network or provider timeout", data: null };
  }
}

