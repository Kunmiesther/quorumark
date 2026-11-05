-- Additive, service-only paper ticket transaction. Live execution is untouched.
create or replace function public.paper_manual_open_position(
  _user_id uuid, _request_id uuid, _ticket jsonb, _payload jsonb
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_wallet public.paper_wallets%rowtype;
  v_existing public.paper_positions%rowtype;
  v_balance numeric;
  v_locked numeric;
  v_margin numeric := (_payload->>'margin')::numeric;
  v_result jsonb;
begin
  perform public._paper_assert_owner(_user_id);
  perform pg_advisory_xact_lock(hashtextextended('paper-manual:' || _user_id::text, 0));
  select * into v_existing from public.paper_positions
    where user_id = _user_id and opened_from_signal = 'manual:' || _request_id::text;
  if found then
    if v_existing.strategy_metadata->'manual_ticket' is distinct from _ticket then
      raise exception 'paper_manual_conflict';
    end if;
    return jsonb_build_object('position_id', v_existing.id);
  end if;
  if _payload->>'strategy' <> 'manual_ticket'
    or _payload->>'wallet_key' not in ('long', 'short')
    or _payload->>'direction' is distinct from _payload->>'wallet_key'
    or _payload->>'opened_from_signal' is distinct from 'manual:' || _request_id::text
    or v_margin is null or v_margin <= 0
    or (_payload->>'entry_ts')::timestamptz < now() - interval '30 seconds'
    or (_payload->>'entry_ts')::timestamptz > now() + interval '5 seconds'
  then raise exception 'paper_manual_invalid'; end if;
  select * into v_wallet from public.paper_wallets
    where user_id = _user_id and wallet_key = _payload->>'wallet_key' for update;
  if not found or v_wallet.status <> 'active' or not v_wallet.execution_enabled
    or v_wallet.open_position_id is not null then raise exception 'paper_manual_wallet'; end if;
  select balance into v_balance from public.paper_accounts where user_id = _user_id for update;
  if not found then raise exception 'paper_manual_account'; end if;
  select coalesce(sum(margin), 0) into v_locked from public.paper_positions
    where user_id = _user_id and status = 'open';
  if v_margin + coalesce((_payload->>'entry_fee')::numeric, 0) > v_balance - v_locked
    then raise exception 'paper_manual_balance'; end if;
  v_result := public.paper_open_position(_user_id, v_wallet.id, _payload);
  update public.paper_positions
    set strategy_metadata = strategy_metadata || jsonb_build_object('manual_ticket', _ticket)
    where id = (v_result->>'position_id')::uuid and user_id = _user_id;
  return v_result;
end;
$$;
revoke all on function public.paper_manual_open_position(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.paper_manual_open_position(uuid, uuid, jsonb, jsonb) to service_role;
