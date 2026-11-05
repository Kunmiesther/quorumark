-- A strategy ID and its child order ID are different identities. Never replace
-- the strategy receipt when recording a child fill or cancellation.
alter table public.order_intents add column if not exists aster_order_id text;
alter table public.order_intents add column if not exists aster_campaign_key text;

-- Serialize the first reservation for a wallet/symbol across signer replicas.
-- All five rungs of one campaign may reserve, but a different campaign or a
-- close cannot race an unresolved intent. No time-based lock expiry permits
-- resubmission: only a confirmed terminal venue observation releases a row.
create or replace function public.guard_aster_intent_reservation()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.venue <> 'aster' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.connection_id::text || ':' || new.symbol,0));
  -- Preserve the ordinary unique-constraint response for exact retries.
  if exists(select 1 from public.order_intents where user_id=new.user_id and client_order_id=new.client_order_id) then
    return new;
  end if;
  if exists(select 1 from public.order_intents i where i.user_id=new.user_id
    and i.connection_id=new.connection_id and i.symbol=new.symbol and i.venue='aster'
    and i.state in ('signing','submitted','open','partially_filled','cancellation_pending','reconciliation_required')
    and not (new.reduce_only=false and i.reduce_only=false
      and new.aster_campaign_key is not null and i.aster_campaign_key is not null
      and i.aster_campaign_key=new.aster_campaign_key)) then
    raise exception 'ASTER_SYMBOL_HAS_UNRESOLVED_INTENT';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_aster_intent_reservation() from public,anon,authenticated;
drop trigger if exists guard_aster_intent_reservation on public.order_intents;
create trigger guard_aster_intent_reservation before insert on public.order_intents
  for each row execute function public.guard_aster_intent_reservation();

create or replace function public.reconcile_aster_order(
  p_user_id uuid, p_connection_id uuid, p_intent_id uuid,
  p_order_id text, p_status text, p_filled numeric
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare r public.order_intents; next_state public.order_intent_state;
begin
  select * into r from public.order_intents
    where id=p_intent_id and user_id=p_user_id and connection_id=p_connection_id
      and venue='aster' and environment='mainnet' for update;
  if not found then raise exception 'ASTER_INTENT_NOT_FOUND'; end if;
  if p_status='UNKNOWN' then
    if r.state in ('signing','submitted','open','partially_filled','cancellation_pending','reconciliation_required') then
      update public.order_intents set state='reconciliation_required',
        state_reason='ASTER_ORDER_OBSERVATION_UNKNOWN' where id=r.id;
    end if;
    return r.id;
  end if;
  if p_order_id is null or length(p_order_id) not between 1 and 128
    or p_filled is null or not (p_filled >= 0 and p_filled <= r.size)
    or p_filled < r.filled_size
    or (r.aster_order_id is not null and r.aster_order_id <> p_order_id) then
    raise exception 'ASTER_OBSERVATION_MISMATCH';
  end if;
  next_state := case p_status
    when 'NEW' then 'open'::public.order_intent_state
    when 'PARTIALLY_FILLED' then 'partially_filled'::public.order_intent_state
    when 'FILLED' then 'filled'::public.order_intent_state
    when 'CANCELED' then 'cancelled'::public.order_intent_state
    when 'EXPIRED' then 'cancelled'::public.order_intent_state
    when 'EXPIRED_IN_MATCH' then 'cancelled'::public.order_intent_state
    when 'REJECTED' then 'rejected'::public.order_intent_state end;
  if next_state is null or (p_status='NEW' and p_filled <> 0)
    or (p_status='FILLED' and p_filled <> r.size)
    or (p_status='PARTIALLY_FILLED' and not (p_filled > 0 and p_filled < r.size)) then
    raise exception 'ASTER_OBSERVATION_INVALID';
  end if;
  if r.state in ('filled','cancelled','rejected','failed') and
    (r.state <> next_state or r.filled_size <> p_filled) then
    raise exception 'ASTER_TERMINAL_STATE_CONFLICT';
  end if;
  update public.order_intents set state=next_state, exchange_status=p_status,
    aster_order_id=p_order_id, filled_size=p_filled, state_reason=null,
    last_reconciled_at=clock_timestamp() where id=r.id;
  return r.id;
end;
$$;
revoke all on function public.reconcile_aster_order(uuid,uuid,uuid,text,text,numeric) from public,anon,authenticated;
grant execute on function public.reconcile_aster_order(uuid,uuid,uuid,text,text,numeric) to service_role;
