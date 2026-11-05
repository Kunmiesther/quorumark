-- Restore the minimum production paper runtime without resetting history.
-- This migration is deliberately simulation-only: no order, signer, exchange
-- credential, or live-execution object is created or referenced.

create table if not exists public.paper_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance numeric not null default 3600 check (balance >= 0),
  realized_pnl numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.paper_test_symbols (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  display_name text not null,
  exchange text not null default 'public_market_data',
  enabled boolean not null default true,
  max_leverage numeric not null default 25 check (max_leverage > 0 and max_leverage <= 100),
  tick_size numeric,
  step_size numeric,
  min_order_size numeric,
  market_available boolean not null default true,
  sort_order integer not null default 100,
  notes text,
  added_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, symbol)
);

create table if not exists public.paper_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  wallet_key text not null,
  balance numeric not null default 0,
  realized_pnl numeric not null default 0,
  open_position_id uuid,
  floor_hit boolean not null default false,
  trades_count integer not null default 0,
  wins_count integer not null default 0,
  losses_count integer not null default 0,
  last_tick_at timestamptz,
  last_processed_candle_ts_ms bigint,
  direction_scope text not null default 'both',
  environment text not null default 'paper',
  status text not null default 'active',
  balance_source text not null default 'shared_account',
  execution_enabled boolean not null default true,
  monitor_role text,
  activated_at timestamptz,
  activated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, wallet_key),
  check (environment = 'paper'),
  check (status in ('active', 'paused', 'disabled'))
);

-- Bring the retained position table up to the shape used by the current
-- fixed-universe simulator. All additions are nullable/defaulted so existing
-- rows remain intact.
alter table public.paper_positions
  alter column stop_level drop not null,
  add column if not exists trend_at_entry text,
  add column if not exists trend_slope_pct_at_entry numeric,
  add column if not exists regime_at_entry text,
  add column if not exists onyx_rationale text,
  add column if not exists ladder_total_notional numeric,
  add column if not exists final_rung_fill_price numeric,
  add column if not exists armed_stop_price numeric,
  add column if not exists ladder_contract_version integer,
  add column if not exists armed_reason text,
  add column if not exists banked_qty numeric,
  add column if not exists banked_pnl_net numeric,
  add column if not exists tp_tiers jsonb,
  add column if not exists opened_margin_mode text not null default 'cross',
  add column if not exists strategy_metadata jsonb not null default '{}'::jsonb,
  add column if not exists capability_reconciliation_required boolean not null default false,
  add column if not exists slot_id uuid,
  add column if not exists authorization_id uuid,
  add column if not exists pod_id uuid,
  add column if not exists leg_id uuid,
  add column if not exists orchestration_trace_id uuid,
  add column if not exists onyx_decision_id uuid;

update public.paper_positions set strategy = 'accumulator' where strategy is null;
update public.paper_positions set rung_count = 1 where rung_count is null;
update public.paper_positions
   set filled_rung_count = coalesce(filled_rung_count, rung_count, 1)
 where filled_rung_count is null;

alter table public.paper_positions alter column strategy set default 'accumulator';
alter table public.paper_positions alter column strategy set not null;
alter table public.paper_positions alter column rung_count set default 1;
alter table public.paper_positions alter column rung_count set not null;
alter table public.paper_positions alter column filled_rung_count set default 1;
alter table public.paper_positions alter column filled_rung_count set not null;

create unique index if not exists paper_positions_one_open_wallet_idx
  on public.paper_positions (user_id, wallet_key) where status = 'open';
create index if not exists paper_positions_user_status_idx
  on public.paper_positions (user_id, status);

alter table public.paper_trades drop constraint if exists paper_trades_exit_reason_check;
alter table public.paper_trades add constraint paper_trades_exit_reason_check
  check (exit_reason in (
    'tp_touch', 'stop', 'floor', 'scout_bos', 'paper_reset',
    'scout_guardian_bos', 'scout_guardian_cluster',
    'htf_promotion_bank', 'htf_bos_exit', 'runner_breakeven_stop'
  ));
create index if not exists paper_trades_user_closed_idx
  on public.paper_trades (user_id, closed_at desc);

create table if not exists public.paper_rung_fills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  position_id uuid not null references public.paper_positions(id) on delete cascade,
  rung_index integer not null check (rung_index > 0),
  fill_price numeric not null,
  qty numeric not null default 0,
  margin numeric not null default 0,
  tp_price numeric not null default 0,
  fill_status text not null default 'filled' check (fill_status in ('filled', 'cancelled', 'rejected')),
  filled_at timestamptz not null default now(),
  candle_ts_ms bigint,
  unique (position_id, rung_index)
);

create table if not exists public.paper_tick_leases (
  user_id uuid not null,
  minute_bucket timestamptz not null,
  claimed_by text not null,
  claimed_at timestamptz not null default now(),
  primary key (user_id, minute_bucket)
);

create table if not exists public.paper_engine_operations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  op_key text not null,
  fingerprint text not null,
  state text not null default 'claimed'
    check (state in ('claimed', 'completed', 'conflict', 'dead_letter', 'orphaned')),
  result jsonb,
  recovery_reason text,
  recovered_at timestamptz,
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, op_key)
);
create index if not exists paper_engine_operations_user_created_idx
  on public.paper_engine_operations (user_id, created_at desc);

create table if not exists public.paper_engine_authority (
  user_id uuid primary key references auth.users(id) on delete cascade,
  mode text not null default 'fixed_universe' check (mode in ('fixed_universe', 'dynamic_universe')),
  enabled_at timestamptz not null default now(),
  notes text
);

-- Seed only missing runtime state. Existing trade and position history is not
-- changed. The fixed paper universe uses public price data and never submits
-- orders to the named market-data venue.
create or replace function public.ensure_paper_wallets(_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_symbol text;
  v_sort integer := 0;
begin
  if _user_id is null or not exists (select 1 from auth.users where id = _user_id) then
    raise exception 'paper_user_invalid' using errcode = '22023';
  end if;

  insert into public.paper_accounts (user_id) values (_user_id)
  on conflict (user_id) do nothing;

  if not exists (select 1 from public.paper_test_symbols where user_id = _user_id) then
    foreach v_symbol in array array['BTC-USDT', 'ETH-USDT', 'SOL-USDT'] loop
      v_sort := v_sort + 1;
      insert into public.paper_test_symbols
        (user_id, symbol, display_name, exchange, max_leverage, sort_order)
      values
        (_user_id, v_symbol, split_part(v_symbol, '-', 1), 'public_market_data',
         case when v_symbol in ('BTC-USDT', 'ETH-USDT') then 100 else 50 end, v_sort)
      on conflict (user_id, symbol) do nothing;
    end loop;
  end if;

  insert into public.paper_wallets (user_id, wallet_key, direction_scope)
  select _user_id, split_part(s.symbol, '-', 1) || '-' || d.direction, d.direction
    from public.paper_test_symbols s
    cross join (values ('long'), ('short')) as d(direction)
   where s.user_id = _user_id and s.enabled and s.market_available
  on conflict (user_id, wallet_key) do nothing;

  insert into public.paper_engine_authority (user_id) values (_user_id)
  on conflict (user_id) do nothing;
end;
$$;

create or replace function public._paper_assert_owner(_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := coalesce(current_setting('request.jwt.claim.role', true), '');
  v_claims text := current_setting('request.jwt.claims', true);
begin
  if _user_id is null then raise exception 'paper_user_required' using errcode = '22023'; end if;
  if v_role = 'service_role'
     or current_user = 'service_role'
     or (v_claims is not null and v_claims::jsonb ->> 'role' = 'service_role') then
    return;
  end if;
  if (select auth.uid()) is null or (select auth.uid()) <> _user_id then
    raise exception 'paper_forbidden' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.claim_paper_tick(
  _user_id uuid,
  _bucket timestamptz default now()
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bucket timestamptz := date_trunc('minute', _bucket);
  v_inserted integer;
begin
  perform public._paper_assert_owner(_user_id);
  insert into public.paper_tick_leases (user_id, minute_bucket, claimed_by)
  values (_user_id, v_bucket,
    case when current_user = 'service_role'
      or current_setting('request.jwt.claim.role', true) = 'service_role'
    then 'service_role' else 'authenticated' end)
  on conflict (user_id, minute_bucket) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end;
$$;

create or replace function public.claim_paper_engine_operation(
  _user_id uuid, _op_key text, _fingerprint text
) returns table(status text, result jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.paper_engine_operations%rowtype;
  v_inserted integer;
begin
  perform public._paper_assert_owner(_user_id);
  if nullif(_op_key, '') is null or nullif(_fingerprint, '') is null then
    raise exception 'paper_operation_invalid' using errcode = '22023';
  end if;
  with inserted as (
    insert into public.paper_engine_operations (user_id, op_key, fingerprint)
    values (_user_id, _op_key, _fingerprint)
    on conflict (user_id, op_key) do nothing returning id
  ) select count(*)::integer into v_inserted from inserted;
  if v_inserted = 1 then return query select 'claimed'::text, null::jsonb; return; end if;

  select * into v_row from public.paper_engine_operations
   where user_id = _user_id and op_key = _op_key for update;
  if v_row.state = 'dead_letter' and
     (v_row.recovered_at is null or v_row.recovered_at <= now() - interval '2 minutes') then
    update public.paper_engine_operations
       set state = 'claimed', fingerprint = _fingerprint, result = null,
           recovery_reason = null, recovered_at = null, claimed_at = now(), updated_at = now()
     where id = v_row.id;
    return query select 'claimed'::text, null::jsonb; return;
  end if;
  if v_row.fingerprint <> _fingerprint then
    return query select 'conflict'::text, null::jsonb; return;
  end if;
  return query select 'replayed'::text, v_row.result;
end;
$$;

create or replace function public.complete_paper_engine_operation(
  _user_id uuid, _op_key text, _result jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public._paper_assert_owner(_user_id);
  update public.paper_engine_operations
     set state = 'completed', result = _result,
         completed_at = coalesce(completed_at, now()), updated_at = now()
   where user_id = _user_id and op_key = _op_key and state = 'claimed';
end;
$$;

create or replace function public.dead_letter_paper_engine_operation(
  _user_id uuid, _op_key text, _reason text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public._paper_assert_owner(_user_id);
  update public.paper_engine_operations
     set state = 'dead_letter', recovery_reason = left(coalesce(_reason, 'unknown'), 120),
         recovered_at = now(), updated_at = now()
   where user_id = _user_id and op_key = _op_key and state = 'claimed';
end;
$$;

create or replace function public.paper_open_position(
  _user_id uuid, _wallet_id uuid, _payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_position_id uuid;
  v_configured integer := nullif(_payload->>'ladder_total_rungs', '')::integer;
  v_fills jsonb := coalesce(_payload->'fills', '[]'::jsonb);
  v_first jsonb;
begin
  perform public._paper_assert_owner(_user_id);
  perform 1 from public.paper_wallets where id = _wallet_id and user_id = _user_id for update;
  if not found then raise exception 'paper_wallet_missing' using errcode = '42501'; end if;

  insert into public.paper_positions (
    user_id, wallet_key, symbol, direction, status, entry_price, entry_ts,
    entry_candle_ts_ms, tp_level, stop_level, zone_lower, zone_upper, zone_level,
    size_qty, size_notional, margin, leverage, entry_fee, opened_from_signal,
    last_seen_candle_ts_ms, trend_at_entry, trend_slope_pct_at_entry, strategy,
    regime_at_entry, onyx_rationale, rung_count, first_fill_vwap, fills,
    resize_levels, pending_rungs, ladder_total_margin, ladder_total_notional,
    ladder_total_rungs, configured_rung_count, filled_rung_count,
    orchestration_trace_id, onyx_decision_id
  ) values (
    _user_id, _payload->>'wallet_key', _payload->>'symbol', _payload->>'direction', 'open',
    (_payload->>'entry_price')::numeric, (_payload->>'entry_ts')::timestamptz,
    (_payload->>'entry_candle_ts_ms')::bigint, nullif(_payload->>'tp_level', '')::numeric,
    nullif(_payload->>'stop_level', '')::numeric, (_payload->>'zone_lower')::numeric,
    (_payload->>'zone_upper')::numeric, (_payload->>'zone_level')::numeric,
    (_payload->>'size_qty')::numeric, (_payload->>'size_notional')::numeric,
    (_payload->>'margin')::numeric, (_payload->>'leverage')::numeric,
    coalesce((_payload->>'entry_fee')::numeric, 0), nullif(_payload->>'opened_from_signal', ''),
    nullif(_payload->>'last_seen_candle_ts_ms', '')::bigint,
    nullif(_payload->>'trend_at_entry', ''), nullif(_payload->>'trend_slope_pct_at_entry', '')::numeric,
    coalesce(nullif(_payload->>'strategy', ''), 'accumulator'),
    nullif(_payload->>'regime_at_entry', ''), nullif(_payload->>'onyx_rationale', ''),
    coalesce((_payload->>'rung_count')::integer, 1), nullif(_payload->>'first_fill_vwap', '')::numeric,
    v_fills, coalesce(_payload->'resize_levels', '[]'::jsonb),
    coalesce(_payload->'pending_rungs', '[]'::jsonb),
    nullif(_payload->>'ladder_total_margin', '')::numeric,
    nullif(_payload->>'ladder_total_notional', '')::numeric, v_configured, v_configured,
    coalesce((_payload->>'rung_count')::integer, 1),
    nullif(_payload->>'orchestration_trace_id', '')::uuid,
    nullif(_payload->>'onyx_decision_id', '')::uuid
  ) returning id into v_position_id;

  update public.paper_wallets set open_position_id = v_position_id, last_tick_at = now()
   where id = _wallet_id and user_id = _user_id;

  if jsonb_array_length(v_fills) > 0 then
    v_first := v_fills->0;
    if v_first->>'price' is not null then
      insert into public.paper_rung_fills
        (user_id, position_id, rung_index, fill_price, qty, margin, tp_price, filled_at, candle_ts_ms)
      values (_user_id, v_position_id, 1, (v_first->>'price')::numeric,
        coalesce((v_first->>'qty')::numeric, 0), coalesce((v_first->>'margin')::numeric, 0),
        coalesce((v_first->>'tp')::numeric, 0), (_payload->>'entry_ts')::timestamptz,
        (_payload->>'entry_candle_ts_ms')::bigint)
      on conflict (position_id, rung_index) do nothing;
    end if;
  end if;
  return jsonb_build_object('position_id', v_position_id);
end;
$$;

create or replace function public.paper_add_rung(
  _user_id uuid, _position_id uuid, _expected_rung_count integer,
  _new_state jsonb, _rung_fills jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current public.paper_positions%rowtype;
  v_fill jsonb;
  v_filled integer;
  v_configured integer;
  v_armed jsonb := _new_state->'armed';
begin
  perform public._paper_assert_owner(_user_id);
  select * into v_current from public.paper_positions
   where id = _position_id and user_id = _user_id for update;
  if not found or v_current.status <> 'open' then raise exception 'paper_position_unavailable'; end if;
  if v_current.rung_count <> _expected_rung_count then raise exception 'paper_rung_conflict'; end if;

  for v_fill in select jsonb_array_elements(coalesce(_rung_fills, '[]'::jsonb)) loop
    if v_fill->>'rung_index' is not null and v_fill->>'price' is not null then
      insert into public.paper_rung_fills
        (user_id, position_id, rung_index, fill_price, qty, margin, tp_price,
         fill_status, filled_at, candle_ts_ms)
      values (_user_id, _position_id, (v_fill->>'rung_index')::integer,
        (v_fill->>'price')::numeric, coalesce((v_fill->>'qty')::numeric, 0),
        coalesce((v_fill->>'margin')::numeric, 0), coalesce((v_fill->>'tp')::numeric, 0),
        coalesce(nullif(v_fill->>'fill_status', ''), 'filled'),
        coalesce(nullif(v_fill->>'filled_at', '')::timestamptz, now()),
        nullif(v_fill->>'candle_ts_ms', '')::bigint)
      on conflict (position_id, rung_index) do nothing;
    end if;
  end loop;
  select count(*) into v_filled from public.paper_rung_fills
   where position_id = _position_id and fill_status = 'filled';
  v_configured := coalesce(v_current.configured_rung_count, v_current.ladder_total_rungs, v_current.rung_count);

  update public.paper_positions set
    entry_price = (_new_state->>'entry_price')::numeric,
    size_qty = (_new_state->>'size_qty')::numeric,
    size_notional = (_new_state->>'size_notional')::numeric,
    margin = (_new_state->>'margin')::numeric,
    entry_fee = (_new_state->>'entry_fee')::numeric,
    rung_count = greatest(v_filled, 1), filled_rung_count = greatest(v_filled, 1),
    tp_level = nullif(_new_state->>'tp_level', '')::numeric,
    fills = coalesce(_new_state->'fills', fills),
    resize_levels = coalesce(_new_state->'resize_levels', resize_levels),
    pending_rungs = coalesce(_new_state->'pending_rungs', pending_rungs),
    last_seen_candle_ts_ms = nullif(_new_state->>'last_seen_candle_ts_ms', '')::bigint,
    stop_level = case when v_filled >= v_configured then
      coalesce(nullif(v_armed->>'armed_stop_price', '')::numeric, stop_level) else stop_level end,
    hard_stop_armed_at = case when v_filled >= v_configured then
      coalesce(hard_stop_armed_at, nullif(v_armed->>'armed_at', '')::timestamptz, now()) else hard_stop_armed_at end,
    final_rung_fill_price = case when v_filled >= v_configured then
      coalesce(final_rung_fill_price, nullif(v_armed->>'final_rung_fill_price', '')::numeric) else final_rung_fill_price end,
    armed_stop_price = case when v_filled >= v_configured then
      coalesce(armed_stop_price, nullif(v_armed->>'armed_stop_price', '')::numeric) else armed_stop_price end,
    ladder_contract_version = coalesce(nullif(v_armed->>'contract_version', '')::integer, ladder_contract_version),
    armed_reason = case when v_filled >= v_configured then
      coalesce(armed_reason, nullif(v_armed->>'reason', '')) else armed_reason end
  where id = _position_id and user_id = _user_id;

  return jsonb_build_object('position_id', _position_id, 'rung_count', greatest(v_filled, 1),
    'filled_rung_count', greatest(v_filled, 1), 'configured_rung_count', v_configured,
    'armed', v_filled >= v_configured);
end;
$$;

create or replace function public.paper_reduce_position(
  _user_id uuid, _position_id uuid, _expected_rung_count integer,
  _trade jsonb, _new_state jsonb, _account_delta numeric,
  _wallet_id uuid, _wallet_stats jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_position public.paper_positions%rowtype; v_trade_id uuid;
begin
  perform public._paper_assert_owner(_user_id);
  select * into v_position from public.paper_positions
   where id = _position_id and user_id = _user_id and status = 'open' for update;
  if not found then raise exception 'paper_position_unavailable'; end if;
  if v_position.rung_count <> _expected_rung_count then raise exception 'paper_rung_conflict'; end if;
  insert into public.paper_trades
    (user_id, wallet_key, symbol, direction, entry_price, exit_price, exit_reason,
     size_qty, size_notional, margin, leverage, pnl_gross, fees, slippage_cost,
     pnl_net, hold_seconds, opened_at, closed_at, position_id)
  values (_user_id, _trade->>'wallet_key', _trade->>'symbol', _trade->>'direction',
    (_trade->>'entry_price')::numeric, (_trade->>'exit_price')::numeric, _trade->>'exit_reason',
    (_trade->>'size_qty')::numeric, (_trade->>'size_notional')::numeric,
    (_trade->>'margin')::numeric, (_trade->>'leverage')::numeric,
    (_trade->>'pnl_gross')::numeric, (_trade->>'fees')::numeric,
    (_trade->>'slippage_cost')::numeric, (_trade->>'pnl_net')::numeric,
    (_trade->>'hold_seconds')::integer, (_trade->>'opened_at')::timestamptz,
    (_trade->>'closed_at')::timestamptz, _position_id) returning id into v_trade_id;
  update public.paper_positions set
    entry_price = (_new_state->>'entry_price')::numeric,
    size_qty = (_new_state->>'size_qty')::numeric,
    size_notional = (_new_state->>'size_notional')::numeric,
    margin = (_new_state->>'margin')::numeric,
    entry_fee = (_new_state->>'entry_fee')::numeric,
    rung_count = (_new_state->>'rung_count')::integer,
    tp_level = nullif(_new_state->>'tp_level', '')::numeric,
    fills = coalesce(_new_state->'fills', fills), resize_levels = coalesce(_new_state->'resize_levels', resize_levels),
    pending_rungs = coalesce(_new_state->'pending_rungs', pending_rungs),
    last_seen_candle_ts_ms = nullif(_new_state->>'last_seen_candle_ts_ms', '')::bigint
  where id = _position_id and user_id = _user_id;
  update public.paper_accounts set balance = balance + coalesce(_account_delta, 0),
    realized_pnl = realized_pnl + coalesce(_account_delta, 0), updated_at = now()
   where user_id = _user_id;
  if _wallet_id is not null then
    update public.paper_wallets set
      trades_count = trades_count + coalesce((_wallet_stats->>'trades_delta')::integer, 0),
      wins_count = wins_count + coalesce((_wallet_stats->>'wins_delta')::integer, 0),
      losses_count = losses_count + coalesce((_wallet_stats->>'losses_delta')::integer, 0), last_tick_at = now()
    where id = _wallet_id and user_id = _user_id;
  end if;
  return jsonb_build_object('trade_id', v_trade_id, 'position_id', _position_id);
end;
$$;

create or replace function public.paper_partial_close_position(
  _user_id uuid, _position_id uuid, _last_seen_candle_ts_ms bigint,
  _trade jsonb, _size_qty_delta numeric, _size_notional_delta numeric,
  _margin_delta numeric, _account_delta numeric, _wallet_id uuid,
  _wallet_stats jsonb, _position_patch jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_position public.paper_positions%rowtype; v_trade_id uuid; v_remaining numeric;
begin
  perform public._paper_assert_owner(_user_id);
  select * into v_position from public.paper_positions
   where id = _position_id and user_id = _user_id and status = 'open' for update;
  if not found then return jsonb_build_object('already_closed', true, 'position_id', _position_id); end if;
  v_remaining := v_position.size_qty - coalesce(_size_qty_delta, 0);
  if v_remaining <= 0 then raise exception 'paper_partial_close_invalid'; end if;
  insert into public.paper_trades
    (user_id, wallet_key, symbol, direction, entry_price, exit_price, exit_reason,
     size_qty, size_notional, margin, leverage, pnl_gross, fees, slippage_cost,
     pnl_net, hold_seconds, opened_at, closed_at, position_id)
  values (_user_id, _trade->>'wallet_key', _trade->>'symbol', _trade->>'direction',
    (_trade->>'entry_price')::numeric, (_trade->>'exit_price')::numeric, _trade->>'exit_reason',
    (_trade->>'size_qty')::numeric, (_trade->>'size_notional')::numeric,
    (_trade->>'margin')::numeric, (_trade->>'leverage')::numeric,
    (_trade->>'pnl_gross')::numeric, (_trade->>'fees')::numeric,
    (_trade->>'slippage_cost')::numeric, (_trade->>'pnl_net')::numeric,
    (_trade->>'hold_seconds')::integer, (_trade->>'opened_at')::timestamptz,
    (_trade->>'closed_at')::timestamptz, _position_id) returning id into v_trade_id;
  update public.paper_positions set size_qty = v_remaining,
    size_notional = greatest(0, size_notional - coalesce(_size_notional_delta, 0)),
    margin = greatest(0, margin - coalesce(_margin_delta, 0)),
    last_seen_candle_ts_ms = coalesce(_last_seen_candle_ts_ms, last_seen_candle_ts_ms),
    promoted = coalesce((_position_patch->>'promoted')::boolean, promoted),
    promoted_at = coalesce(nullif(_position_patch->>'promoted_at', '')::timestamptz, promoted_at),
    runner_breakeven_stop = coalesce(nullif(_position_patch->>'runner_breakeven_stop', '')::numeric, runner_breakeven_stop),
    banked_qty = coalesce(banked_qty, 0) + coalesce((_position_patch->>'banked_qty_add')::numeric, 0),
    banked_pnl_net = coalesce(banked_pnl_net, 0) + coalesce((_position_patch->>'banked_pnl_net_add')::numeric, 0),
    stop_level = case when _position_patch ? 'stop_level' then nullif(_position_patch->>'stop_level', '')::numeric else stop_level end,
    tp_level = case when _position_patch ? 'tp_level' then nullif(_position_patch->>'tp_level', '')::numeric else tp_level end,
    pending_rungs = case when _position_patch ? 'pending_rungs' then _position_patch->'pending_rungs' else pending_rungs end
   where id = _position_id and user_id = _user_id;
  update public.paper_accounts set balance = balance + coalesce(_account_delta, 0),
    realized_pnl = realized_pnl + coalesce(_account_delta, 0), updated_at = now() where user_id = _user_id;
  if _wallet_id is not null then
    update public.paper_wallets set trades_count = trades_count + coalesce((_wallet_stats->>'trades_delta')::integer, 0),
      wins_count = wins_count + coalesce((_wallet_stats->>'wins_delta')::integer, 0),
      losses_count = losses_count + coalesce((_wallet_stats->>'losses_delta')::integer, 0), last_tick_at = now()
     where id = _wallet_id and user_id = _user_id;
  end if;
  return jsonb_build_object('already_closed', false, 'position_id', _position_id,
    'trade_id', v_trade_id, 'remaining_qty', v_remaining);
end;
$$;

create or replace function public.paper_close_position(
  _user_id uuid, _position_id uuid, _last_seen_candle_ts_ms bigint,
  _trades jsonb, _account_delta numeric, _wallet_id uuid, _wallet_stats jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_changed integer; v_trade jsonb; v_trade_id uuid; v_trade_ids uuid[] := array[]::uuid[];
begin
  perform public._paper_assert_owner(_user_id);
  update public.paper_positions set status = 'closed',
    last_seen_candle_ts_ms = coalesce(_last_seen_candle_ts_ms, last_seen_candle_ts_ms)
   where id = _position_id and user_id = _user_id and status = 'open';
  get diagnostics v_changed = row_count;
  if v_changed = 0 then return jsonb_build_object('already_closed', true, 'position_id', _position_id); end if;
  for v_trade in select jsonb_array_elements(coalesce(_trades, '[]'::jsonb)) loop
    insert into public.paper_trades
      (user_id, wallet_key, symbol, direction, entry_price, exit_price, exit_reason,
       size_qty, size_notional, margin, leverage, pnl_gross, fees, slippage_cost,
       pnl_net, hold_seconds, opened_at, closed_at, position_id)
    values (_user_id, v_trade->>'wallet_key', v_trade->>'symbol', v_trade->>'direction',
      (v_trade->>'entry_price')::numeric, (v_trade->>'exit_price')::numeric, v_trade->>'exit_reason',
      (v_trade->>'size_qty')::numeric, (v_trade->>'size_notional')::numeric,
      (v_trade->>'margin')::numeric, (v_trade->>'leverage')::numeric,
      (v_trade->>'pnl_gross')::numeric, (v_trade->>'fees')::numeric,
      (v_trade->>'slippage_cost')::numeric, (v_trade->>'pnl_net')::numeric,
      (v_trade->>'hold_seconds')::integer, (v_trade->>'opened_at')::timestamptz,
      (v_trade->>'closed_at')::timestamptz, _position_id) returning id into v_trade_id;
    v_trade_ids := v_trade_ids || v_trade_id;
  end loop;
  update public.paper_accounts set balance = balance + coalesce(_account_delta, 0),
    realized_pnl = realized_pnl + coalesce(_account_delta, 0), updated_at = now() where user_id = _user_id;
  if _wallet_id is not null then
    update public.paper_wallets set open_position_id = null,
      trades_count = trades_count + coalesce((_wallet_stats->>'trades_delta')::integer, 0),
      wins_count = wins_count + coalesce((_wallet_stats->>'wins_delta')::integer, 0),
      losses_count = losses_count + coalesce((_wallet_stats->>'losses_delta')::integer, 0),
      last_processed_candle_ts_ms = coalesce(_last_seen_candle_ts_ms, last_processed_candle_ts_ms),
      last_tick_at = now() where id = _wallet_id and user_id = _user_id;
  end if;
  return jsonb_build_object('already_closed', false, 'position_id', _position_id,
    'trade_ids', to_jsonb(v_trade_ids));
end;
$$;

-- Least-privilege Data API surface. Users may read their own simulator state
-- and configure their own symbol watchlist. All accounting mutations are
-- service-only transactional RPCs.
alter table public.paper_accounts enable row level security;
alter table public.paper_test_symbols enable row level security;
alter table public.paper_wallets enable row level security;
alter table public.paper_positions enable row level security;
alter table public.paper_trades enable row level security;
alter table public.paper_rung_fills enable row level security;
alter table public.paper_engine_operations enable row level security;
alter table public.paper_engine_authority enable row level security;

drop policy if exists "Users can view their own paper account" on public.paper_accounts;
create policy "Users can view their own paper account" on public.paper_accounts
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users manage own paper test symbols" on public.paper_test_symbols;
create policy "Users manage own paper test symbols" on public.paper_test_symbols
  for all to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists "Users manage own paper wallets" on public.paper_wallets;
drop policy if exists "Users view own paper wallets" on public.paper_wallets;
create policy "Users view own paper wallets" on public.paper_wallets
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users manage own paper positions" on public.paper_positions;
drop policy if exists "Users view own paper positions" on public.paper_positions;
create policy "Users view own paper positions" on public.paper_positions
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users manage own paper trades" on public.paper_trades;
drop policy if exists "Users view own paper trades" on public.paper_trades;
create policy "Users view own paper trades" on public.paper_trades
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users view own paper rung fills" on public.paper_rung_fills;
create policy "Users view own paper rung fills" on public.paper_rung_fills
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "own paper engine operations readable" on public.paper_engine_operations;
create policy "own paper engine operations readable" on public.paper_engine_operations
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users view own paper engine authority" on public.paper_engine_authority;
create policy "Users view own paper engine authority" on public.paper_engine_authority
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.paper_accounts, public.paper_wallets, public.paper_positions,
  public.paper_trades, public.paper_rung_fills, public.paper_engine_operations,
  public.paper_engine_authority from anon, authenticated;
grant select on public.paper_accounts, public.paper_wallets, public.paper_positions,
  public.paper_trades, public.paper_rung_fills, public.paper_engine_operations,
  public.paper_engine_authority to authenticated;
grant select, insert, update, delete on public.paper_test_symbols to authenticated;
grant all on public.paper_accounts, public.paper_test_symbols, public.paper_wallets,
  public.paper_positions, public.paper_trades, public.paper_rung_fills,
  public.paper_tick_leases, public.paper_engine_operations,
  public.paper_engine_authority to service_role;

revoke all on function public.ensure_paper_wallets(uuid), public._paper_assert_owner(uuid),
  public.claim_paper_tick(uuid, timestamptz),
  public.claim_paper_engine_operation(uuid, text, text),
  public.complete_paper_engine_operation(uuid, text, jsonb),
  public.dead_letter_paper_engine_operation(uuid, text, text),
  public.paper_open_position(uuid, uuid, jsonb),
  public.paper_add_rung(uuid, uuid, integer, jsonb, jsonb),
  public.paper_reduce_position(uuid, uuid, integer, jsonb, jsonb, numeric, uuid, jsonb),
  public.paper_partial_close_position(uuid, uuid, bigint, jsonb, numeric, numeric, numeric, numeric, uuid, jsonb, jsonb),
  public.paper_close_position(uuid, uuid, bigint, jsonb, numeric, uuid, jsonb)
from public, anon, authenticated;

grant execute on function public.claim_paper_tick(uuid, timestamptz) to authenticated, service_role;
grant execute on function public.ensure_paper_wallets(uuid), public._paper_assert_owner(uuid),
  public.claim_paper_engine_operation(uuid, text, text),
  public.complete_paper_engine_operation(uuid, text, jsonb),
  public.dead_letter_paper_engine_operation(uuid, text, text),
  public.paper_open_position(uuid, uuid, jsonb),
  public.paper_add_rung(uuid, uuid, integer, jsonb, jsonb),
  public.paper_reduce_position(uuid, uuid, integer, jsonb, jsonb, numeric, uuid, jsonb),
  public.paper_partial_close_position(uuid, uuid, bigint, jsonb, numeric, numeric, numeric, numeric, uuid, jsonb, jsonb),
  public.paper_close_position(uuid, uuid, bigint, jsonb, numeric, uuid, jsonb)
to service_role;

-- Initialize missing rows for existing users without changing balances or
-- positions that already exist.
do $$ declare v_user uuid; begin
  for v_user in select id from auth.users loop
    perform public.ensure_paper_wallets(v_user);
  end loop;
end $$;
