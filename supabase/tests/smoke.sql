-- Run in the Supabase SQL editor AFTER 001_schema.sql. Everything is rolled back at the end.
-- Any failed assertion aborts with an error; success prints nothing and leaves no data.
begin;
insert into public.payment_orders (order_id,user_id,kind,sku,description,amount_minor,currency)
values ('smoke-1','u1','ONE_TIME','x','x',100,'LKR'),
       ('smoke-2','u1','SUBSCRIPTION','y','y',100,'LKR');

do $$
declare r text;
begin
  r := public.apply_payhere_event('fp1','smoke-1','p1',null,'2',null,'PAID',100,'LKR');
  assert r = 'APPLIED', 'first paid callback: ' || r;
  r := public.apply_payhere_event('fp1','smoke-1','p1',null,'2',null,'PAID',100,'LKR');
  assert r = 'DUPLICATE', 'replay must be duplicate: ' || r;
  r := public.apply_payhere_event('fp2','smoke-1','p2',null,'-2',null,'FAILED',100,'LKR');
  assert r = 'IGNORED', 'PAID cannot go to FAILED: ' || r;
  assert (select count(*) from public.ledger_entries where order_id='smoke-1') = 1, 'one ledger row';
  assert (select count(*) from public.fulfillments   where order_id='smoke-1') = 1, 'one fulfilment';
  r := public.apply_payhere_event('fp3','smoke-1','p1',null,'-3',null,'CHARGEDBACK',100,'LKR');
  assert r = 'APPLIED', 'chargeback after paid: ' || r;
  assert (select sum(amount_minor) from public.ledger_entries where order_id='smoke-1') = 0, 'ledger nets to zero';

  r := public.apply_payhere_event('s1','smoke-2','p1','sub1','2','AUTHORIZATION_SUCCESS','ACTIVE',100,'LKR');
  assert r = 'APPLIED', 'sub auth: ' || r;
  r := public.apply_payhere_event('s2','smoke-2','p2','sub1','2','RECURRING_INSTALLMENT_SUCCESS','ACTIVE',100,'LKR');
  assert r = 'APPLIED', 'installment 1: ' || r;
  r := public.apply_payhere_event('s3','smoke-2','p3','sub1','2','RECURRING_INSTALLMENT_SUCCESS','ACTIVE',100,'LKR');
  assert r = 'APPLIED', 'installment 2: ' || r;
  assert (select count(*) from public.ledger_entries where order_id='smoke-2') = 2, 'two installments recorded';

  begin
    delete from public.ledger_entries where order_id = 'smoke-2';
    assert false, 'ledger delete must be blocked';
  exception when raise_exception then null;
  end;

  assert public.rate_limit_hit('smoke', 60, 2) = true;
  assert public.rate_limit_hit('smoke', 60, 2) = true;
  assert public.rate_limit_hit('smoke', 60, 2) = false, 'third hit must be limited';
end $$;
rollback;
