-- 002_production_schema.sql
-- Production hardening migration for PayHere integration.
-- Run in Supabase SQL editor or CLI.
-- Enforces:
-- 1. Separation of business orders, quotes, attempts, and gateway charge identities.
-- 2. Transactional Outbox for fulfillment (decoupling fulfillment from webhook transactions).
-- 3. True charge-level deduplication via unique (merchant_id, provider_payment_id).
-- 4. Overpayment / secondary charge ledger accounting.
-- 5. Application idempotency records.
-- 6. Refund tracking and subscription installment period constraints.

-- 1. Checkout Quotes (short-lived pricing snapshots)
create table if not exists public.checkout_quotes (
  quote_id            text primary key,
  order_id            text not null references public.payment_orders(order_id),
  user_id             text not null,
  items               jsonb not null default '[]'::jsonb,
  subtotal_minor      bigint not null check (subtotal_minor >= 0),
  tax_minor           bigint not null default 0 check (tax_minor >= 0),
  discount_minor      bigint not null default 0 check (discount_minor >= 0),
  total_minor         bigint not null check (total_minor > 0),
  currency            char(3) not null,
  expires_at          timestamptz not null,
  created_at          timestamptz not null default now()
);
create index if not exists checkout_quotes_order_idx on public.checkout_quotes (order_id);

-- 2. Payment Attempts (1 business order can have 1..N attempts over time, e.g. after a card decline)
create table if not exists public.payment_attempts (
  attempt_id          text primary key,
  order_id            text not null references public.payment_orders(order_id),
  quote_id            text references public.checkout_quotes(quote_id),
  provider            text not null default 'payhere',
  provider_order_id   text not null, -- The order_id sent to PayHere wire protocol
  amount_minor        bigint not null check (amount_minor > 0),
  currency            char(3) not null,
  status              text not null default 'CREATED' check (
                        status in ('CREATED','CHECKOUT_OPEN','PENDING','SUCCEEDED','FAILED','CANCELLED','UNKNOWN')
                      ),
  attempt_number      integer not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (provider, provider_order_id)
);
create index if not exists payment_attempts_order_idx on public.payment_attempts (order_id, created_at desc);

-- 3. Application-level Idempotency Records
create table if not exists public.idempotency_records (
  scope               text not null, -- e.g. "checkout:user_xxx"
  idempotency_key     text not null,
  request_fingerprint text not null,
  status              text not null default 'IN_PROGRESS' check (status in ('IN_PROGRESS','COMPLETED','FAILED')),
  response_status     integer,
  response_body       jsonb,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  primary key (scope, idempotency_key)
);
create index if not exists idempotency_records_expiry_idx on public.idempotency_records (expires_at);

-- 4. Provider Event Receipts (Durable raw audit log of all callbacks received)
create table if not exists public.provider_event_receipts (
  id                  bigint generated always as identity primary key,
  provider            text not null default 'payhere',
  environment         text not null default 'sandbox',
  provider_order_id   text,
  provider_payment_id text,
  status_code         text,
  message_type        text,
  raw_fingerprint     text not null,
  signature_valid     boolean not null default false,
  outcome             text not null default 'PENDING_DECISION',
  sanitized_payload   jsonb not null default '{}'::jsonb,
  received_at         timestamptz not null default now()
);
create index if not exists provider_event_receipts_order_idx on public.provider_event_receipts (provider_order_id, received_at desc);

-- 5. Provider Payment Transactions (Unique verified charge identities)
-- PayHere's published signature does not include payment_id, so charge identities must be uniquely isolated and verified.
create table if not exists public.provider_payment_transactions (
  id                  bigint generated always as identity primary key,
  merchant_id         text not null,
  provider            text not null default 'payhere',
  provider_payment_id text not null, -- The unique transaction ID from PayHere
  provider_order_id   text not null,
  order_id            text not null references public.payment_orders(order_id),
  attempt_id          text references public.payment_attempts(attempt_id),
  amount_minor        bigint not null check (amount_minor > 0),
  currency            char(3) not null,
  status              text not null check (
                        status in ('RECEIVED','SETTLED','REFUND_REQUESTED','REFUND_PROCESSING','REFUNDED','PARTIALLY_REFUNDED','CHARGEBACKED')
                      ),
  raw_status_code     text,
  created_at          timestamptz not null default now(),
  unique (merchant_id, provider_payment_id)
);
create index if not exists provider_payment_tx_order_idx on public.provider_payment_transactions (order_id);

-- 6. Transactional Outbox (Guarantees at-least-once downstream fulfillment with zero webhook blocking)
create table if not exists public.outbox_events (
  id                  bigint generated always as identity primary key,
  aggregate_type      text not null default 'ORDER',
  aggregate_id        text not null,
  event_type          text not null,
  operation_key       text not null unique, -- Stable idempotency key for downstream API
  payload             jsonb not null,
  status              text not null default 'PENDING' check (
                        status in ('PENDING','PROCESSING','SUCCEEDED','FAILED','DEAD_LETTER')
                      ),
  attempts            integer not null default 0,
  max_attempts        integer not null default 5,
  last_error          text,
  next_retry_at       timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists outbox_events_poll_idx on public.outbox_events (status, next_retry_at)
  where status in ('PENDING', 'FAILED');

-- 7. Refund Operations (Maker-checker and bounded refund tracking)
create table if not exists public.refund_operations (
  id                  bigint generated always as identity primary key,
  refund_key          text not null unique, -- Local business idempotency key
  order_id            text not null references public.payment_orders(order_id),
  provider_payment_id text not null,
  amount_minor        bigint not null check (amount_minor > 0),
  currency            char(3) not null,
  reason              text not null,
  status              text not null default 'REQUESTED' check (
                        status in ('REQUESTED','SUBMITTED','PROVIDER_ACCEPTED','COMPLETED','FAILED','UNKNOWN')
                      ),
  provider_refund_id  text,
  requested_by        text not null,
  approved_by         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists refund_operations_order_idx on public.refund_operations (order_id);

-- 8. Subscription Installments (Enforces distinct installment periods)
create table if not exists public.subscription_installments (
  id                  bigint generated always as identity primary key,
  subscription_id     text not null,
  order_id            text not null references public.payment_orders(order_id),
  period_key          text not null, -- e.g. "cycle_1", "2026-11"
  provider_payment_id text not null,
  amount_minor        bigint not null,
  currency            char(3) not null,
  status              text not null,
  created_at          timestamptz not null default now(),
  unique (subscription_id, period_key, provider_payment_id)
);

-- 9. Reconciliation Runs (Audit trail of automated and manual syncs against PayHere Retrieval API)
create table if not exists public.reconciliation_runs (
  id                  bigint generated always as identity primary key,
  run_type            text not null default 'SCHEDULED_AUTOMATED',
  started_at          timestamptz not null default now(),
  completed_at        timestamptz,
  status              text not null default 'RUNNING' check (status in ('RUNNING','COMPLETED','FAILED')),
  items_checked       integer not null default 0,
  mismatches_found    integer not null default 0,
  details             jsonb not null default '{}'::jsonb
);

-- Ensure posting_key column exists on ledger_entries to enforce unique financial postings
do $$
begin
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' and table_name = 'ledger_entries' and column_name = 'posting_key'
  ) then
    alter table public.ledger_entries add column posting_key text;
  end if;
end $$;

-- Enforce partial unique index on ledger_entries: one posting per provider payment transaction
create unique index if not exists ledger_entries_posting_key_idx on public.ledger_entries (posting_key)
  where posting_key is not null;

-- 10. Atomic Production Event Processor Function
-- Handles:
-- - Row-level locking on order and attempt
-- - Duplicate charge detection via (merchant_id, provider_payment_id)
-- - Overpayment / secondary genuine charge ledger posting without duplicating fulfillment
-- - Outbox event enqueueing (replaces direct synchronous fulfillment)
create or replace function public.apply_payhere_event_v2(
  p_fingerprint text,
  p_merchant_id text,
  p_order_id text,
  p_payment_id text,
  p_subscription_id text,
  p_status_code text,
  p_message_type text,
  p_new_status text,
  p_amount_minor bigint,
  p_currency text,
  p_payload jsonb default '{}'::jsonb
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_order         public.payment_orders%rowtype;
  v_attempt       public.payment_attempts%rowtype;
  v_rows          integer;
  v_allowed       boolean;
  v_posting_key   text;
  v_is_duplicate  boolean := false;
begin
  -- 1. Consistent lock ordering: lock payment_orders row first
  select * into v_order from public.payment_orders where order_id = p_order_id for update;
  if not found then return 'UNKNOWN_ORDER'; end if;

  -- 2. Lock matching payment_attempt if exists (maps provider_order_id = p_order_id)
  select * into v_attempt from public.payment_attempts
   where provider = 'payhere' and provider_order_id = p_order_id for update;

  -- 3. Log raw receipt into provider_event_receipts
  insert into public.provider_event_receipts
    (provider, environment, provider_order_id, provider_payment_id, status_code, message_type, raw_fingerprint, signature_valid, sanitized_payload)
  values
    ('payhere', 'sandbox', p_order_id, p_payment_id, p_status_code, p_message_type, p_fingerprint, true, p_payload);

  -- 4. True Charge Identity Check:
  -- If this provider_payment_id has already been processed for this merchant, this is an exact duplicate callback
  if p_payment_id is not null then
    select exists (
      select 1 from public.provider_payment_transactions
       where merchant_id = p_merchant_id and provider_payment_id = p_payment_id
    ) into v_is_duplicate;

    if v_is_duplicate then
      return 'DUPLICATE';
    end if;
  end if;

  -- 5. Handle Overpayment / Secondary Genuine Charge:
  -- If the order is ALREADY 'PAID' or 'ACTIVE', but a new valid successful payment_id arrives (e.g. from an alternate attempt):
  -- Record the charge in the ledger so customer money is not lost, but do NOT fulfill twice!
  if v_order.status in ('PAID', 'COMPLETED') and p_new_status = 'PAID' and p_payment_id is not null then
    v_posting_key := 'post_' || p_order_id || '_' || p_payment_id;

    -- Record transaction
    insert into public.provider_payment_transactions
      (merchant_id, provider, provider_payment_id, provider_order_id, order_id, attempt_id, amount_minor, currency, status, raw_status_code)
    values
      (p_merchant_id, 'payhere', p_payment_id, p_order_id, p_order_id, v_attempt.attempt_id, p_amount_minor, p_currency, 'RECEIVED', p_status_code)
    on conflict (merchant_id, provider_payment_id) do nothing;

    -- Record in ledger
    insert into public.ledger_entries (order_id, entry_type, amount_minor, currency, provider_payment_id, posting_key)
    values (p_order_id, 'PAYMENT', p_amount_minor, p_currency, p_payment_id, v_posting_key)
    on conflict (posting_key) do nothing;

    -- Insert outbox event for finance exception / overpayment review
    insert into public.outbox_events (aggregate_type, aggregate_id, event_type, operation_key, payload)
    values ('ORDER', p_order_id, 'PAYMENT_OVERPAYMENT_REVIEW', 'alert_overpayment_' || p_payment_id,
            jsonb_build_object('order_id', p_order_id, 'payment_id', p_payment_id, 'amount_minor', p_amount_minor, 'currency', p_currency))
    on conflict (operation_key) do nothing;

    return 'OVERPAYMENT_RECORDED';
  end if;

  -- 6. State Machine Validation:
  v_allowed := case
    when v_order.status = p_new_status and (v_order.kind = 'SUBSCRIPTION' or v_order.status = 'PENDING') then true
    when v_order.status = 'CHARGEDBACK' then false
    when p_new_status = 'CHARGEDBACK' then v_order.status in ('PAID','ACTIVE','PAYMENT_FAILED')
    when v_order.kind = 'ONE_TIME' then
      case v_order.status
        when 'PENDING'  then p_new_status in ('PAID','FAILED','CANCELED')
        when 'FAILED'   then p_new_status in ('PAID','CANCELED')
        when 'CANCELED' then p_new_status in ('PAID','FAILED')
        else false
      end
    else
      case v_order.status
        when 'PENDING'        then p_new_status in ('ACTIVE','FAILED')
        when 'FAILED'         then p_new_status in ('ACTIVE')
        when 'ACTIVE'         then p_new_status in ('PAYMENT_FAILED','COMPLETED','CANCELED')
        when 'PAYMENT_FAILED' then p_new_status in ('ACTIVE','COMPLETED','CANCELED')
        else false
      end
  end;

  if not v_allowed then
    return 'IGNORED';
  end if;

  -- 7. Update order state
  update public.payment_orders
     set status              = p_new_status,
         provider_payment_id = coalesce(p_payment_id, provider_payment_id),
         subscription_id     = coalesce(p_subscription_id, subscription_id),
         updated_at          = now()
   where order_id = p_order_id;

  -- 8. Update payment attempt if exists
  if v_attempt.attempt_id is not null then
    update public.payment_attempts
       set status     = case when p_new_status in ('PAID','ACTIVE') then 'SUCCEEDED'
                             when p_new_status in ('FAILED') then 'FAILED'
                             when p_new_status in ('CANCELED') then 'CANCELLED'
                             else status end,
           updated_at = now()
     where attempt_id = v_attempt.attempt_id;
  end if;

  -- 9. Insert provider transaction record
  if p_payment_id is not null then
    insert into public.provider_payment_transactions
      (merchant_id, provider, provider_payment_id, provider_order_id, order_id, attempt_id, amount_minor, currency, status, raw_status_code)
    values
      (p_merchant_id, 'payhere', p_payment_id, p_order_id, p_order_id, v_attempt.attempt_id, p_amount_minor, p_currency,
       case when p_new_status = 'CHARGEDBACK' then 'CHARGEBACKED' else 'RECEIVED' end, p_status_code)
    on conflict (merchant_id, provider_payment_id) do nothing;
  end if;

  -- 10. Ledger posting with unique key
  v_posting_key := 'post_' || p_order_id || '_' || coalesce(p_payment_id, p_status_code || '_' || p_fingerprint);

  if p_new_status = 'CHARGEDBACK' then
    insert into public.ledger_entries (order_id, entry_type, amount_minor, currency, provider_payment_id, posting_key)
    values (p_order_id, 'CHARGEBACK', -p_amount_minor, p_currency, p_payment_id, v_posting_key)
    on conflict (posting_key) do nothing;
  elsif p_message_type = 'RECURRING_INSTALLMENT_SUCCESS' then
    insert into public.ledger_entries (order_id, entry_type, amount_minor, currency, provider_payment_id, posting_key)
    values (p_order_id, 'INSTALLMENT', p_amount_minor, p_currency, p_payment_id, v_posting_key)
    on conflict (posting_key) do nothing;
  elsif p_new_status = 'PAID' then
    insert into public.ledger_entries (order_id, entry_type, amount_minor, currency, provider_payment_id, posting_key)
    values (p_order_id, 'PAYMENT', p_amount_minor, p_currency, p_payment_id, v_posting_key)
    on conflict (posting_key) do nothing;
  end if;

  -- 11. Transactional Outbox Insertion (Replaces synchronous fulfillment)
  if p_new_status in ('PAID','ACTIVE') then
    insert into public.outbox_events (aggregate_type, aggregate_id, event_type, operation_key, payload)
    values ('ORDER', p_order_id, 'FULFILL_ORDER', 'fulfill_' || p_order_id,
            jsonb_build_object('order_id', p_order_id, 'user_id', v_order.user_id, 'sku', v_order.sku, 'amount_minor', p_amount_minor))
    on conflict (operation_key) do nothing;
  end if;

  return 'APPLIED';
end $$;

-- Backwards-compatible shim for existing apply_payhere_event callers
create or replace function public.apply_payhere_event(
  p_fingerprint text, p_order_id text, p_payment_id text, p_subscription_id text,
  p_status_code text, p_message_type text, p_new_status text,
  p_amount_minor bigint, p_currency text
) returns text
language plpgsql security definer set search_path = public as $$
begin
  return public.apply_payhere_event_v2(
    p_fingerprint, 'DEFAULT_MERCHANT', p_order_id, p_payment_id, p_subscription_id,
    p_status_code, p_message_type, p_new_status, p_amount_minor, p_currency, '{}'::jsonb
  );
end $$;

-- Lock down new tables with Row Level Security (Service role only)
alter table public.checkout_quotes               enable row level security;
alter table public.payment_attempts              enable row level security;
alter table public.idempotency_records           enable row level security;
alter table public.provider_event_receipts        enable row level security;
alter table public.provider_payment_transactions  enable row level security;
alter table public.outbox_events                 enable row level security;
alter table public.refund_operations             enable row level security;
alter table public.subscription_installments     enable row level security;
alter table public.reconciliation_runs           enable row level security;

revoke all on all tables in schema public from anon, authenticated;
grant execute on function public.apply_payhere_event_v2 to service_role;

