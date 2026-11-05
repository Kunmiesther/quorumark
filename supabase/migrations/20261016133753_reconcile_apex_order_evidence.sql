-- Read-only venue observations. Never infer cancellation from absence, and
-- never release a failed-protection intent while its symbol is exposed.
create table if not exists public.apex_order_recovery_audit (
  id bigint generated always as identity primary key,
  intent_id uuid not null references public.order_intents(id),
  user_id uuid not null,
  connection_id uuid not null,
  observed_at timestamptz not null default clock_timestamp(),
  before_image jsonb not null,
  evidence jsonb not null,
  outcome text not null
);
alter table public.apex_order_recovery_audit enable row level security;
revoke all on public.apex_order_recovery_audit from public,anon,authenticated,service_role;
grant select,insert on public.apex_order_recovery_audit to service_role;
grant usage on sequence public.apex_order_recovery_audit_id_seq to service_role;
create index if not exists apex_order_recovery_pending_idx
  on public.order_intents(connection_id,last_reconciled_at nulls first,created_at)
  where venue='apex_omni' and state='reconciliation_required';

create or replace function public.reconcile_apex_order_evidence(
  p_user_id uuid,p_connection_id uuid,p_intent_id uuid,p_evidence jsonb
) returns text language plpgsql security invoker set search_path='' as $$
declare r public.order_intents; o jsonb; target public.order_intent_state;
  filled numeric; qty numeric; venue_id text; outcome text := 'UNRESOLVED';
  observed timestamptz; expected_client_id text; cleaned text;
begin
  select * into r from public.order_intents where id=p_intent_id
    and user_id=p_user_id and connection_id=p_connection_id
    and venue='apex_omni' and environment='mainnet' for update;
  if not found then raise exception 'APEX_INTENT_NOT_FOUND'; end if;
  if r.state <> 'reconciliation_required' then return 'UNCHANGED'; end if;
  if jsonb_typeof(p_evidence) <> 'object' or octet_length(p_evidence::text)>8000 then
    raise exception 'APEX_EVIDENCE_INVALID'; end if;
  observed := (p_evidence->>'observed_at')::timestamptz;
  if observed is null or observed < clock_timestamp()-interval '60 seconds'
    or observed > clock_timestamp()+interval '5 seconds' then raise exception 'APEX_EVIDENCE_STALE'; end if;
  o := p_evidence->'order';
  cleaned := regexp_replace(r.client_order_id,'[^A-Za-z0-9]','','g');
  expected_client_id := case when cleaned=r.client_order_id and length(cleaned)<=32 then cleaned
    else left(coalesce(nullif(left(cleaned,8),''),'tb') ||
      left(encode(sha256(convert_to(r.client_order_id,'UTF8')),'hex'),24),32) end;
  if jsonb_typeof(o)='object' then
    venue_id := nullif(o->>'id','');
    qty := (o->>'size')::numeric;
    filled := (o->>'filled_size')::numeric;
    if venue_id is null or length(venue_id)>128
      or o->>'client_order_id' is distinct from expected_client_id
      or o->>'symbol' is distinct from r.symbol or o->>'side' is distinct from r.side
      or o->>'order_type' is distinct from r.order_type
      or (o->>'reduce_only')::boolean is distinct from r.reduce_only
      or qty is distinct from r.size or filled is null
      or not(filled>=0 and filled<=r.size) or filled<coalesce(r.filled_size,0)
      or (r.exchange_order_id is not null and r.exchange_order_id<>venue_id) then
      raise exception 'APEX_ORDER_IDENTITY_MISMATCH';
    end if;
    target := case o->>'status'
      when 'FILLED' then 'filled'::public.order_intent_state
      when 'CANCELED' then 'cancelled'::public.order_intent_state
      when 'CANCELLED' then 'cancelled'::public.order_intent_state
      when 'EXPIRED' then 'cancelled'::public.order_intent_state
      when 'REJECTED' then 'rejected'::public.order_intent_state end;
    if (target='filled' and filled<>r.size) or (target='rejected' and filled<>0) then
      raise exception 'APEX_FILL_STATUS_MISMATCH'; end if;
    if target is not null and p_evidence->'symbol_flat'= 'true'::jsonb
      and p_evidence->'symbol_orders_empty'='true'::jsonb then
      outcome := 'RESOLVED';
    end if;
  end if;
  insert into public.apex_order_recovery_audit(intent_id,user_id,connection_id,before_image,evidence,outcome)
    values(r.id,r.user_id,r.connection_id,to_jsonb(r),p_evidence,outcome);
  if outcome='RESOLVED' then
    update public.order_intents set state=target,exchange_order_id=venue_id,
      exchange_status=o->>'status',filled_size=filled,
      state_reason='APEX_TERMINAL_ORDER_AND_FLAT_VERIFIED',last_reconciled_at=clock_timestamp()
      where id=r.id;
  else
    -- Rotation without erasing the original failure reason or asserting no fill.
    update public.order_intents set last_reconciled_at=clock_timestamp() where id=r.id;
  end if;
  return outcome;
end;
$$;
revoke all on function public.reconcile_apex_order_evidence(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.reconcile_apex_order_evidence(uuid,uuid,uuid,jsonb) to service_role;

-- Separate evidence collection from settlement. These observations alone do
-- not change P&L, strategy attribution, loss budgets, or trade permissions.
create table if not exists public.apex_closed_pnl_observations (
  position_id uuid primary key references public.positions(id),
  user_id uuid not null,
  connection_id uuid not null,
  observed_at timestamptz not null default clock_timestamp(),
  evidence jsonb not null
);
alter table public.apex_closed_pnl_observations enable row level security;
revoke all on public.apex_closed_pnl_observations from public,anon,authenticated,service_role;
grant select,insert,update on public.apex_closed_pnl_observations to service_role;
