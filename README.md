# PayHere Production Payment Integration (Next.js 16 + Supabase + Clerk)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-16.4.0-black.svg)](https://nextjs.org/)
[![PostgreSQL](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E.svg)](https://supabase.com/)
[![PayHere](https://img.shields.io/badge/PayHere-v2.0-orange.svg)](https://www.payhere.lk/)
[![Tests](https://img.shields.io/badge/Tests-29%20Passed-brightgreen.svg)]()

A production-grade, enterprise-ready payment gateway integration for [PayHere](https://www.payhere.lk/) (Central Bank of Sri Lanka licensed). Built with **Next.js 16 App Router**, **TypeScript**, **Supabase PostgreSQL**, and **Clerk Authentication**.

Designed in accordance with the official [`PayHere Production Implementation Handbook`](./PayHere_Production_Implementation_Handbook_Frontend_to_Backend.md), enforcing strict ACID guarantees, application-level idempotency, an append-only financial ledger, constant-time signature verification, anti-parameter pollution defenses, a transactional outbox for decoupled fulfillment, automated retrieval reconciliation, and administrative refund controls.

---

## Table of Contents

1. [Architecture & Trust Boundaries](#1-architecture--trust-boundaries)
2. [Key Production Invariants & Security Controls](#2-key-production-invariants--security-controls)
3. [Database Schema & ACID Model](#3-database-schema--acid-model)
4. [PayHere Protocol Implementation](#4-payhere-protocol-implementation)
5. [API Reference](#5-api-reference)
6. [Local Development & Setup](#6-local-development--setup)
7. [Receiving Callbacks Locally (Tunnel Setup)](#7-receiving-callbacks-locally-tunnel-setup)
8. [Automated Testing & Verification](#8-automated-testing--verification)
9. [Operations, Reconciliation & Runbooks](#9-operations-reconciliation--runbooks)
10. [Production Deployment Checklist](#10-production-deployment-checklist)

---

## 1. Architecture & Trust Boundaries

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                              TRUST BOUNDARY: BROWSER                           │
│  - Catalog & Checkout Form (CatalogClient.tsx)                                 │
│  - payhere-2.0.js SDK Modal Popup                                              │
│  - Polling Status Monitor (StatusPoller.tsx)                                   │
└───────────────────────┬──────────────────────────────────┬─────────────────────┘
                        │ HTTPS (Idempotency-Key)          │ GET status (Opaque ID)
                        ▼                                  ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│                          APPLICATION SERVER (Next.js 16)                       │
│  ┌────────────────────────┐  ┌───────────────────────┐  ┌───────────────────┐  │
│  │  Checkout & Quote API  │  │ Public notify_url     │  │ Status & Admin    │  │
│  │  - Price/Tax calc      │  │ - Parameter sanitize  │  │ - Owner auth      │  │
│  │  - Attempt generator   │  │ - Constant-time md5sig│  │ - RBAC refunds    │  │
│  │  - Server-side signing │  │ - Association check   │  │ - Reconciliation  │  │
│  └───────────┬────────────┘  └───────────┬───────────┘  └─────────┬─────────┘  │
└──────────────┼───────────────────────────┼────────────────────────┼────────────┘
               │                           │                        │
               ▼                           ▼                        ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│                       POSTGRESQL DATABASE (ACID CORE)                          │
│  - payment_orders & checkout_quotes (Immutable price snapshots)                │
│  - payment_attempts (State machine, attempt counter)                           │
│  - idempotency_records (Request hash, cached responses)                         │
│  - provider_event_receipts (Audit log of all raw callbacks)                    │
│  - provider_payment_transactions (Unique verified provider charge IDs)         │
│  - ledger_entries (Append-only immutable financial accounting)                 │
│  - outbox_events (Transactional messaging for fulfillment)                     │
│  - refund_operations (Idempotent refund requests & tracking)                   │
└──────────────────────────────────────────┬─────────────────────────────────────┘
                                           │ Worker Polling (SKIP LOCKED)
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│                    BACKGROUND WORKERS & RECONCILIATION ENGINE                  │
│  - Outbox Fulfillment Worker (Idempotent stock / digital license delivery)     │
│  - PayHere Retrieval API Sync Worker (OAuth 2.0, 20 req/10s rate limiter)       │
│  - Stale Attempt Expiry & Ambiguous Charge Quarantine                          │
└────────────────────────────────────────────────────────────────────────────────┘
```

### Trust Boundary Rules
- **The Browser is Never Authoritative:** Client-submitted prices, discounts, or payment statuses are never trusted. Visiting `/payment/return` or `/payment/cancel` changes nothing in the database.
- **Server Owns Pricing and Signing:** Amounts, currency, and items are determined strictly by server-side catalogs. The PayHere request hash is computed server-side; `PAYHERE_MERCHANT_SECRET` never leaves the server environment.
- **Webhook Authenticated Cryptographically:** The public `notify_url` endpoint validates the raw URL-encoded payload, enforces constant-time `md5sig` checking, and validates amounts against the database order snapshot.
- **Fulfillment Decoupled via Transactional Outbox:** Payment webhooks commit financial records and enqueue an outbox job atomically. Downstream actions (email, inventory, licensing) execute asynchronously via workers.

---

## 2. Key Production Invariants & Security Controls

| Threat / Risk | Mitigating Architecture | Implementation Location |
|---|---|---|
| **Price Tampering** | Server calculates prices and snapshots quotes; browser price overrides are rejected. | `lib/products.ts`, `app/api/payhere/checkout/route.ts` |
| **Secret Exposure** | Secrets stored server-side only; logger redacts tokens, hashes, and card fields. | `lib/env.ts`, `lib/logger.ts` |
| **Forged Webhooks** | Constant-time `timingSafeEqual` MD5 checksum verification against merchant secret. | `lib/payhere/sign.ts` |
| **Parameter Pollution (HPP)** | URL-encoded parser rejects duplicate critical keys (`order_id`, `payhere_amount`, etc.). | `app/api/payhere/notify/route.ts` |
| **Replay / Duplicate Webhooks** | Unique constraint on `provider_payment_transactions(merchant_id, provider_payment_id)`. | `supabase/migrations/002_production_schema.sql` |
| **Secondary Genuine Payments** | Overpayments recorded in the ledger and flagged for review without duplicating fulfillment. | `apply_payhere_event_v2()` in SQL |
| **Missing Checkouts / Races** | Application-level `Idempotency-Key` header with request fingerprinting. | `lib/payments/idempotency.ts` |
| **BOLA / IDOR** | All customer queries and status reads are scoped strictly to the authenticated Clerk `user_id`. | `app/api/orders/[id]/status/route.ts` |
| **CSRF Attacks** | Cookie-authenticated mutating endpoints enforce Same-Origin verification. | `lib/security/origin.ts` |
| **Rate Limiter IP Spoofing** | Sanitizes client IPs and prioritizes trusted proxy headers (`CF-Connecting-IP`, `X-Real-IP`). | `lib/security/origin.ts` |
| **Cardholder Data Security** | Card input is fully hosted in PayHere's secure modal iframe; no PAN/CVV touches application servers. | `app/catalog/CatalogClient.tsx` |

---

## 3. Database Schema & ACID Model

The database architecture decouples commercial intent, gateway attempts, provider charges, and business fulfillment into normalized tables:

### Core Tables
1. **`payment_orders`**: Business order entity (`order_id`, `user_id`, `amount_minor`, `currency`, `status`).
2. **`checkout_quotes`**: Short-lived pricing snapshot (`quote_id`, `order_id`, `items`, `total_minor`, `expires_at`).
3. **`payment_attempts`**: Individual payment gateway attempts (`attempt_id`, `order_id`, `provider_order_id`, `status`, `attempt_number`).
4. **`idempotency_records`**: Client request cache (`scope`, `idempotency_key`, `request_fingerprint`, `response_body`, `expires_at`).
5. **`provider_event_receipts`**: Raw, immutable audit log of every inbound webhook delivery.
6. **`provider_payment_transactions`**: Unique verified gateway charge records (`merchant_id`, `provider_payment_id`, `amount_minor`, `status`).
7. **`ledger_entries`**: Append-only double-entry financial journal. Protected by a trigger that blocks `UPDATE` and `DELETE` operations.
8. **`outbox_events`**: Transactional messaging queue for downstream fulfillment jobs.
9. **`refund_operations`**: Bounded refund requests (`refund_key`, `order_id`, `amount_minor`, `status`, `provider_refund_id`).
10. **`subscription_installments`**: Recurring installment records constrained by `(subscription_id, period_key, provider_payment_id)`.
11. **`reconciliation_runs`**: Auditable log of automated and manual Retrieval API reconciliation syncs.

### State Transitions (`apply_payhere_event_v2`)
- **One-Time Payments:** `PENDING` ➔ `PAID`, `FAILED`, `CANCELED`.
- **Backward Transition Protection:** An order in `PAID` can **never** regress to `FAILED` or `CANCELED`.
- **Chargebacks (`-3`):** Moves `PAID` ➔ `CHARGEDBACK` and appends a balancing negative entry to `ledger_entries`.
- **Secondary Payments:** If an order is already `PAID` and another valid payment callback arrives with a distinct `payment_id`, the funds are captured in `ledger_entries`, flagged for overpayment review, and fulfillment is preserved at exactly once.

---

## 4. PayHere Protocol Implementation

### Server-Side Hash Formula
When launching checkout, the server generates the MD5 hash:
```
hash = UPPER(MD5(merchant_id + order_id + amount_formatted + currency + UPPER(MD5(merchant_secret))))
```
*Note: Amount must be formatted to exactly two decimal places (e.g. `2500.00`).*

### Webhook Verification Formula
Inbound `notify_url` POST callbacks are verified against:
```
md5sig = UPPER(MD5(merchant_id + order_id + payhere_amount + payhere_currency + status_code + UPPER(MD5(merchant_secret))))
```
*Note: PayHere's `md5sig` covers merchant, order, amount, currency, and status, but excludes `payment_id` and `message_type`. The application isolates charge identities in `provider_payment_transactions` rather than trusting signature validity alone.*

### JavaScript SDK (v2.0)
The frontend integrates with `https://www.payhere.lk/lib/payhere-2.0.js`. In popup mode:
- `return_url: undefined` and `cancel_url: undefined` (per official PayHere JS SDK documentation).
- Navigation is handled through `payhere.onCompleted` and `payhere.onDismissed`.
- `onCompleted` triggers polling of the authenticated status endpoint (`/api/orders/[id]/status`) rather than self-declaring payment success.

---

## 5. API Reference

### Customer Endpoints
- **`POST /api/payhere/checkout`**
  - **Headers:** `Idempotency-Key: <unique-string>` (optional but recommended).
  - **Body:** `{ sku, phone, address, city }`.
  - **Description:** Validates user session, creates a pending order, freezes a checkout quote, creates a payment attempt, and returns server-signed fields for `payhere.startPayment()`.
- **`GET /api/orders/{id}/status`**
  - **Description:** Authoritative payment and fulfillment status monitor. Scoped strictly to the order owner.
  - **Headers:** `Cache-Control: private, no-store`.
  - **Response:** `{ order_id, attempt_id, payment_state, fulfillment_state, amount_minor, currency, display_message_code, can_retry, updated_at }`.

### Payment Gateway Webhook
- **`POST /api/payhere/notify`**
  - **Content-Type:** `application/x-www-form-urlencoded`.
  - **Description:** Public callback handler. Verifies `md5sig`, re-validates commercial snapshot, executes atomic database state transition, and acknowledges with HTTP 200.

### Administrative & Background Cron Endpoints
- **`GET /api/cron/outbox`**
  - **Headers:** `Authorization: Bearer <CRON_SECRET>`.
  - **Description:** Processes pending Transactional Outbox fulfillment events with exponential backoff and dead-letter queueing.
- **`GET /api/cron/reconcile`**
  - **Headers:** `Authorization: Bearer <CRON_SECRET>`.
  - **Description:** Polls PayHere Retrieval API (`/merchant/v1/payment/search`) for stale `PENDING` attempts and reconciles missing callbacks.
- **`POST /api/admin/refunds`**
  - **Authorization:** Clerk user with admin privilege.
  - **Body:** `{ orderId, amountMinor?, reason }`.
  - **Description:** Validates remaining refundable balance, creates durable refund operation, submits request to PayHere Refund API, and records negative ledger entry.

---

## 6. Local Development & Setup

### Prerequisites
- Node.js 22+
- A [Clerk](https://clerk.com/) application
- A [Supabase](https://supabase.com/) PostgreSQL project
- A [PayHere Sandbox](https://sandbox.payhere.lk/) account

### 1. Installation
```bash
git clone <repo-url> payhere-demo
cd payhere-demo
npm install
```

### 2. Database Migrations
In your Supabase SQL Editor, run the migrations in order:
1. `supabase/migrations/001_schema.sql` (baseline schema and triggers)
2. `supabase/migrations/002_production_schema.sql` (production normalization, outbox, and v2 event engine)

Run the verification smoke tests:
```sql
-- In Supabase SQL Editor:
-- (Executes assertions and automatically rolls back)
\i supabase/tests/smoke_002.sql
```

### 3. Environment Variables
Create your local environment file:
```bash
cp .env.example .env.local
```

Configure `.env.local`:
```ini
# Clerk Auth
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...

# Supabase (Server-only service role)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# PayHere Sandbox
PAYHERE_MODE=sandbox
PAYHERE_MERCHANT_ID=your_sandbox_merchant_id
PAYHERE_MERCHANT_SECRET=your_domain_row_secret

# Application URL
APP_URL=http://localhost:3000

# Optional tunnel for local callbacks (see Section 7)
PAYHERE_NOTIFY_BASE_URL=

# Admin User IDs (Comma-separated Clerk User IDs)
ADMIN_USER_IDS=user_xxx
```

### 4. Configure PayHere Sandbox Domain
1. Log in to [sandbox.payhere.lk](https://sandbox.payhere.lk) ➔ **Integrations** ➔ **Add Domain/App**.
2. Set Domain to `localhost` and save.
3. Copy the **Merchant Secret** shown in the `localhost` row to `PAYHERE_MERCHANT_SECRET` in `.env.local`.

---

## 7. Receiving Callbacks Locally (Tunnel Setup)

PayHere validates the checkout origin domain (`localhost`), but server-to-server callbacks (`notify_url`) must reach a publicly accessible HTTPS endpoint.

1. Start a Cloudflare quick tunnel:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
2. Copy the generated tunnel URL (e.g. `https://random-name.trycloudflare.com`).
3. Set `PAYHERE_NOTIFY_BASE_URL` in `.env.local`:
   ```ini
   PAYHERE_NOTIFY_BASE_URL=https://random-name.trycloudflare.com
   ```
4. Restart your development server:
   ```bash
   npm run dev
   ```

---

## 8. Automated Testing & Verification

The project includes an automated test suite verifying unit logic, cryptographic signing, webhook security, idempotency key collision resistance, financial state machine invariants, and refund balance bounding.

### Run Unit & Concurrency Tests
```bash
npm test
```
*Executes 29 automated test cases across 5 test suites.*

### Run Typecheck
```bash
npm run typecheck
```

### Sandbox Test Cards (PayHere Official)

| Test Scenario | Visa Card Number | Expiry | CVV | Expected App Result |
|---|---|---|---|---|
| **Successful Payment** | `4916 2175 0161 1292` | `12/30` | `123` | `PAID` (Fulfilled) |
| **Insufficient Funds** | `4024 0071 9434 9121` | `12/30` | `123` | `FAILED` (Retry safe) |
| **Limit Exceeded** | `4929 1197 9936 5646` | `12/30` | `123` | `FAILED` (Retry safe) |
| **Do Not Honor** | `4929 7689 0083 7248` | `12/30` | `123` | `FAILED` (Retry safe) |
| **Network Error** | `4024 0071 2086 9333` | `12/30` | `123` | `FAILED` (Retry safe) |

---

## 9. Operations, Reconciliation & Runbooks

Operational runbooks and incident response procedures are documented in [`docs/payment/operations-runbook.md`](./docs/payment/operations-runbook.md).

### Summary Runbooks
- **Callback Outage / Ingress Failure:** Trigger `GET /api/cron/reconcile` to poll PayHere's Retrieval API and recover all in-flight payments automatically.
- **Double Charge Inquiry:** Check `ledger_entries` by `order_id`. If two distinct `provider_payment_id` rows exist, use the `/admin` refund console to issue an immediate refund for the secondary charge.
- **Ambiguous Refund Timeout:** Inspect `refund_operations` status (`UNKNOWN`). Reconcile with the PayHere portal before issuing a new refund to avoid double crediting.

---

## 10. Production Deployment Checklist

Prior to routing real customer payments:

1. **Production Domain & Secrets:**
   - Register your production top-level domain (e.g. `shop.example.com`) in the **Live** PayHere portal.
   - Set `PAYHERE_MODE=live`, `PAYHERE_MERCHANT_ID`, and the production domain secret in your hosting provider's secret store (Vercel, AWS, etc.).
   - Set `APP_URL=https://shop.example.com` and leave `PAYHERE_NOTIFY_BASE_URL` empty.
2. **IP Whitelisting for Merchant APIs:**
   - Email `support@payhere.lk` with your server's outbound production IP address to enable Live access to the Retrieval API and Refund API.
3. **Database Migration:**
   - Apply `001_schema.sql` and `002_production_schema.sql` to your production Supabase database.
4. **Scheduled Background Workers:**
   - Configure a recurring cron schedule (every 1–5 minutes) invoking `GET /api/cron/outbox` and `GET /api/cron/reconcile` with `Bearer <CRON_SECRET>`.
5. **Mandatory Website Information:**
   - Ensure the published [`/terms`](./app/terms/page.tsx), [`/privacy`](./app/privacy/page.tsx), and [`/refund-policy`](./app/refund-policy/page.tsx) pages accurately display your registered business legal name, contact email, telephone, and physical address.
6. **Live Canary Verification:**
   - Execute a controlled low-value transaction (e.g. 100.00 LKR) with a real card. Verify callback receipt, ledger credit, outbox fulfillment, and issue an administrative refund to verify end-to-end accounting.

---

## License

This project is licensed under the MIT License.
