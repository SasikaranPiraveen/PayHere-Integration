-- PayHere demo schema. Run in the Supabase SQL editor (or `supabase db push`).
-- All access happens server-side with the service_role key. RLS is enabled with NO policies,
-- so the public anon/authenticated keys can read or write nothing.

create table if not exists public.payment_orders (
  order_id            text primary key,
  user_id             text not null,                       -- Clerk user id
  kind                text not null check (kind in ('ONE_TIME','SUBSCRIPTION')),
  sku                 text not null,
  description         text not null,
  amount_minor        bigint not null check (amount_minor > 0),
  currency            char(3) not null,
  status              text not null default 'PENDING' check (status in
                        ('PENDING','PAID','FAILED','CANCELED','CHARGEDBACK','ACTIVE','PAYMENT_FAILED','COMPLETED')),
  provider_payment_id text,
  subscription_id     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists payment_orders_user_idx on public.payment_orders (user_id, created_at desc);

-- Replay / idempotency guard: one row per distinct callback.
create table if not exists public.payhere_events (
  fingerprint         text primary key,
  order_id            text not null references public.payment_orders(order_id),
  provider_payment_id text,
  subscription_id     text,
  status_code         text not null,
  message_type        text,
  outcome             text not null default 'PENDING_DECISION',
  received_at         timestamptz not null default now()
);

-- Append-only financial ledger.
create table if not exists public.ledger_entries (
  id                  bigint generated always as identity primary key,
  order_id            text not null references public.payment_orders(order_id),
  entry_type          text not null check (entry_type in ('PAYMENT','INSTALLMENT','CHARGEBACK','REFUND')),
  amount_minor        bigint not null,                     -- negative for chargebacks/refunds
  currency            char(3) not null,
  provider_payment_id text,
  created_at          timestamptz not null default now()
);

-- Fulfilment happens at most once per order, enforced by the primary key.
create table if not exists public.fulfillments (
  order_id     text primary key references public.payment_orders(order_id),
  fulfilled_at timestamptz not null default now()
);

-- Every callback we receive, including rejected ones (feeds the admin Webhook Inspector).
create table if not exists public.webhook_log (
  id           bigint generated always as identity primary key,
  received_at  timestamptz not null default now(),
  order_id     text,
  result       text not null,
  message_type text,
  status_code  text,
  latency_ms   integer,
  ip           text
);

create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  actor      text not null,
  action     text not null,
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.rate_limits (
  key          text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (key, window_start)
);

-- The ledger can never be edited or deleted.
create or replace function public.forbid_ledger_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'ledger_entries is append-only';
end $$;

drop trigger if exists ledger_no_mutation on public.ledger_entries;
create trigger ledger_no_mutation before update or delete on public.ledger_entries
  for each row execute function public.forbid_ledger_mutation();

-- Atomic, idempotent state transition. Everything below happens in ONE transaction and
-- the order row is locked, so concurrent duplicate deliveries serialize safely.
create or replace function public.apply_payhere_event(
  p_fingerprint text, p_order_id text, p_payment_id text, p_subscription_id text,
  p_status_code text, p_message_type text, p_new_status text,
  p_amount_minor bigint, p_currency text
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_order   public.payment_orders%rowtype;
  v_rows    integer;
  v_allowed boolean;
begin
  select * into v_order from public.payment_orders where order_id = p_order_id for update;
  if not found then return 'UNKNOWN_ORDER'; end if;

  insert into public.payhere_events
    (fingerprint, order_id, provider_payment_id, subscription_id, status_code, message_type)
  values
    (p_fingerprint, p_order_id, p_payment_id, p_subscription_id, p_status_code, p_message_type)
  on conflict (fingerprint) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return 'DUPLICATE'; end if;

  -- Allowed transitions (a late or out-of-order event can never move an order backwards).
  v_allowed := case
    when v_order.status = p_new_status
         and (v_order.kind = 'SUBSCRIPTION' or v_order.status = 'PENDING') then true
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
    update public.payhere_events set outcome = 'IGNORED_TRANSITION' where fingerprint = p_fingerprint;
    return 'IGNORED';
  end if;

  update public.payment_orders
     set status              = p_new_status,
         provider_payment_id = coalesce(p_payment_id, provider_payment_id),
         subscription_id     = coalesce(p_subscription_id, subscription_id),
         updated_at          = now()
   where order_id = p_order_id;

  if p_new_status = 'CHARGEDBACK' then
    insert into public.ledger_entries (order_id, entry_type, amount_minor, currency, provider_payment_id)
    values (p_order_id, 'CHARGEBACK', -p_amount_minor, p_currency, p_payment_id);
  elsif p_message_type = 'RECURRING_INSTALLMENT_SUCCESS' then
    insert into public.ledger_entries (order_id, entry_type, amount_minor, currency, provider_payment_id)
    values (p_order_id, 'INSTALLMENT', p_amount_minor, p_currency, p_payment_id);
  elsif p_new_status = 'PAID' then
    insert into public.ledger_entries (order_id, entry_type, amount_minor, currency, provider_payment_id)
    values (p_order_id, 'PAYMENT', p_amount_minor, p_currency, p_payment_id);
  end if;

  if p_new_status in ('PAID','ACTIVE') then
    insert into public.fulfillments (order_id) values (p_order_id) on conflict do nothing;
  end if;

  update public.payhere_events set outcome = 'APPLIED' where fingerprint = p_fingerprint;
  return 'APPLIED';
end $$;

-- Fixed-window rate limiter usable from serverless (no Redis needed for the demo).
create or replace function public.rate_limit_hit(p_key text, p_window_seconds integer, p_max integer)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_window timestamptz;
  v_hits   integer;
begin
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limits (key, window_start, hits) values (p_key, v_window, 1)
  on conflict (key, window_start) do update set hits = public.rate_limits.hits + 1
  returning hits into v_hits;
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '1 day';
  end if;
  return v_hits <= p_max;
end $$;

-- Lock everything down: only the server-side service_role may touch data or call functions.
alter table public.payment_orders enable row level security;
alter table public.payhere_events enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.fulfillments   enable row level security;
alter table public.webhook_log    enable row level security;
alter table public.audit_log      enable row level security;
alter table public.rate_limits    enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on function public.apply_payhere_event(text,text,text,text,text,text,text,bigint,text) from public, anon, authenticated;
revoke all on function public.rate_limit_hit(text,integer,integer) from public, anon, authenticated;
grant execute on function public.apply_payhere_event(text,text,text,text,text,text,text,bigint,text) to service_role;
grant execute on function public.rate_limit_hit(text,integer,integer) to service_role;
