-- smoke_002.sql
-- Verification test for 002_production_schema.sql.
-- Rolls back at the end so no test data is retained.
begin;

-- Insert base orders
insert into public.payment_orders (order_id, user_id, kind, sku, description, amount_minor, currency)
values ('smoke-p1', 'user_1', 'ONE_TIME', 'starter-license', 'Starter License', 250000, 'LKR'),
       ('smoke-p2', 'user_1', 'SUBSCRIPTION', 'saas-monthly', 'SaaS Monthly', 150000, 'LKR');

-- Create an attempt for smoke-p1
insert into public.payment_attempts (attempt_id, order_id, provider, provider_order_id, amount_minor, currency, status)
values ('att_1', 'smoke-p1', 'payhere', 'smoke-p1', 250000, 'LKR', 'CHECKOUT_OPEN');

do $$
declare
  r text;
begin
  -- 1. First success callback
  r := public.apply_payhere_event_v2('fp_1', 'MERCH_1', 'smoke-p1', 'PAY_1', null, '2', null, 'PAID', 250000, 'LKR', '{"sample":1}'::jsonb);
  assert r = 'APPLIED', 'first paid callback must be APPLIED, got: ' || r;

  -- Verify ledger entry was created
  assert (select count(*) from public.ledger_entries where order_id = 'smoke-p1') = 1, 'one ledger row expected';

  -- Verify outbox event was queued for fulfillment
  assert (select count(*) from public.outbox_events where aggregate_id = 'smoke-p1' and event_type = 'FULFILL_ORDER') = 1, 'one outbox fulfillment event expected';

  -- 2. Exact duplicate callback with same payment_id
  r := public.apply_payhere_event_v2('fp_1_dup', 'MERCH_1', 'smoke-p1', 'PAY_1', null, '2', null, 'PAID', 250000, 'LKR', '{"sample":2}'::jsonb);
  assert r = 'DUPLICATE', 'duplicate payment_id must be recognized as DUPLICATE, got: ' || r;

  -- 3. Secondary genuine payment (Overpayment scenario)
  r := public.apply_payhere_event_v2('fp_2', 'MERCH_1', 'smoke-p1', 'PAY_2', null, '2', null, 'PAID', 250000, 'LKR', '{"sample":3}'::jsonb);
  assert r = 'OVERPAYMENT_RECORDED', 'secondary genuine payment on paid order must record overpayment, got: ' || r;

  -- Ledger must now have TWO rows (both customer payments accounted for)
  assert (select count(*) from public.ledger_entries where order_id = 'smoke-p1') = 2, 'two ledger rows expected after overpayment';

  -- But outbox fulfillment must NOT be duplicated (still exactly 1 fulfillment event)
  assert (select count(*) from public.outbox_events where aggregate_id = 'smoke-p1' and event_type = 'FULFILL_ORDER') = 1, 'fulfillment must NOT duplicate';

  -- Overpayment review alert must be queued
  assert (select count(*) from public.outbox_events where aggregate_id = 'smoke-p1' and event_type = 'PAYMENT_OVERPAYMENT_REVIEW') = 1, 'overpayment review outbox expected';
end $$;

rollback;

