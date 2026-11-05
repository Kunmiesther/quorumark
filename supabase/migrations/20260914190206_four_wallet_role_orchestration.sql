-- Owner-approved paper portfolio contract:
--   exactly four active role wallets: long, short, hedge, strategy
--   BTC/XRP/SOL/ETH only
--   2-of-3 (1h/4h/1d) aligned opportunities execute mechanically in long/short
--   failed-alignment opportunities may execute only after Council -> Onyx,
--   as DCA in the strategy wallet
-- Historical wallets/trades are retained for audit; legacy wallets are disabled.

drop index if exists public.paper_positions_one_open_wallet_idx;

-- Move any currently-open legacy directional positions into their role wallet
-- before disabling the old symbol-specific wallet rows.
update public.paper_positions
   set wallet_key = case direction when 'long' then 'long' else 'short' end
 where status = 'open'
   and wallet_key not in ('long', 'short', 'hedge', 'strategy');

create unique index if not exists paper_positions_one_open_wallet_symbol_idx
  on public.paper_positions (user_id, wallet_key, symbol)
  where status = 'open';

insert into public.paper_wallets
  (user_id, wallet_key, direction_scope, balance, balance_source, status)
select a.user_id, r.wallet_key, r.direction_scope,
       greatest(a.balance, 0) / 4, 'shared_account', 'active'
  from public.paper_accounts a
 cross join (values
   ('long', 'long'),
   ('short', 'short'),
   ('hedge', 'both'),
   ('strategy', 'both')
 ) as r(wallet_key, direction_scope)
on conflict (user_id, wallet_key) do update
  set direction_scope = excluded.direction_scope,
      balance_source = 'shared_account',
      status = 'active',
      execution_enabled = true;

update public.paper_wallets
   set status = 'disabled', execution_enabled = false
 where wallet_key not in ('long', 'short', 'hedge', 'strategy');

-- `open_position_id` was a single-slot compatibility pointer and cannot
-- represent one campaign per symbol. Position occupancy is authoritative in
-- paper_positions; clear stale pointers before role wallets become active.
update public.paper_wallets set open_position_id = null;

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

  foreach v_symbol in array array['BTC-USDT', 'XRP-USDT', 'SOL-USDT', 'ETH-USDT'] loop
    v_sort := v_sort + 1;
    insert into public.paper_test_symbols
      (user_id, symbol, display_name, exchange, max_leverage, sort_order, enabled)
    values
      (_user_id, v_symbol, split_part(v_symbol, '-', 1), 'public_market_data',
       case when v_symbol in ('BTC-USDT', 'ETH-USDT') then 100 else 50 end,
       v_sort, true)
    on conflict (user_id, symbol) do update
      set enabled = true,
          sort_order = excluded.sort_order;
  end loop;

  update public.paper_test_symbols
     set enabled = false
   where user_id = _user_id
     and symbol not in ('BTC-USDT', 'XRP-USDT', 'SOL-USDT', 'ETH-USDT');

  insert into public.paper_wallets
    (user_id, wallet_key, direction_scope, balance, balance_source, status)
  select _user_id, r.wallet_key, r.direction_scope,
         greatest(a.balance, 0) / 4, 'shared_account', 'active'
    from public.paper_accounts a
   cross join (values
      ('long', 'long'),
      ('short', 'short'),
      ('hedge', 'both'),
      ('strategy', 'both')
    ) as r(wallet_key, direction_scope)
   where a.user_id = _user_id
  on conflict (user_id, wallet_key) do update
    set direction_scope = excluded.direction_scope,
        balance_source = 'shared_account',
        status = 'active',
        execution_enabled = true;

  update public.paper_wallets
     set status = 'disabled', execution_enabled = false
   where user_id = _user_id
     and wallet_key not in ('long', 'short', 'hedge', 'strategy');

  insert into public.paper_engine_authority (user_id) values (_user_id)
  on conflict (user_id) do nothing;
end;
$$;

revoke all on function public.ensure_paper_wallets(uuid)
  from public, anon, authenticated;
grant execute on function public.ensure_paper_wallets(uuid) to service_role;

-- Serialize symbol entry decisions and enforce the role contract in the DB,
-- including protection against concurrent paper ticks.
create or replace function public.paper_positions_four_wallet_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wallet_status text;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || ':' || new.symbol, 0));

  if new.symbol not in ('BTC-USDT', 'XRP-USDT', 'SOL-USDT', 'ETH-USDT') then
    raise exception 'paper_symbol_outside_four_symbol_scan' using errcode = 'check_violation';
  end if;
  if new.wallet_key not in ('long', 'short', 'hedge', 'strategy') then
    raise exception 'paper_wallet_role_invalid' using errcode = 'check_violation';
  end if;

  select w.status into v_wallet_status
    from public.paper_wallets w
   where w.user_id = new.user_id and w.wallet_key = new.wallet_key;
  if v_wallet_status is distinct from 'active' then
    raise exception 'paper_wallet_role_inactive' using errcode = 'check_violation';
  end if;

  if new.wallet_key = 'long' and new.direction <> 'long' then
    raise exception 'paper_long_wallet_direction_invalid' using errcode = 'check_violation';
  end if;
  if new.wallet_key = 'short' and new.direction <> 'short' then
    raise exception 'paper_short_wallet_direction_invalid' using errcode = 'check_violation';
  end if;
  if new.wallet_key = 'strategy' and new.strategy <> 'dca' then
    raise exception 'paper_strategy_wallet_requires_dca' using errcode = 'check_violation';
  end if;

  if new.wallet_key in ('long', 'short', 'strategy') and exists (
    select 1 from public.paper_positions p
     where p.user_id = new.user_id
       and p.symbol = new.symbol
       and p.status = 'open'
       and p.wallet_key in ('long', 'short', 'strategy')
  ) then
    raise exception 'paper_symbol_campaign_already_open' using errcode = 'unique_violation';
  end if;

  if new.wallet_key = 'hedge' and not exists (
    select 1 from public.paper_positions p
     where p.user_id = new.user_id
       and p.symbol = new.symbol
       and p.status = 'open'
       and p.wallet_key in ('long', 'short')
       and p.direction <> new.direction
  ) then
    raise exception 'paper_hedge_requires_opposite_core_position' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.paper_positions_four_wallet_guard()
  from public, anon, authenticated;
grant execute on function public.paper_positions_four_wallet_guard() to service_role;

drop trigger if exists paper_positions_four_wallet_guard_trg on public.paper_positions;
create trigger paper_positions_four_wallet_guard_trg
  before insert on public.paper_positions
  for each row execute function public.paper_positions_four_wallet_guard();

-- Core and hedge entries are deterministic. Only Strategy-wallet DCA must
-- carry an unused, exact Council -> Onyx approval trace.
create or replace function public.paper_positions_require_orchestration()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trace uuid;
  v_onyx uuid;
begin
  if new.wallet_key in ('long', 'short', 'hedge') then
    new.orchestration_trace_id := null;
    new.onyx_decision_id := null;
    return new;
  end if;

  if new.wallet_key <> 'strategy' or new.strategy <> 'dca' then
    raise exception 'paper_ai_route_requires_strategy_dca'
      using errcode = 'check_violation';
  end if;

  select o.trace_id, o.onyx_decision_id
    into v_trace, v_onyx
    from public.paper_ai_orchestrations o
   where o.trace_id = new.orchestration_trace_id
     and o.user_id = new.user_id
     and o.symbol = new.symbol
     and o.direction = new.direction
     and o.strategy = 'dca'
     and o.candle_ts_ms = new.entry_candle_ts_ms
     and o.record_kind = 'runtime'
     and o.snapshot_valid = true
     and o.providers_attempted >= 3
     and o.onyx_decision = 'enter'
     and o.gate_allowed = true
     and o.risk_checked = true
     and o.risk_passed = true
     and o.terminal_outcome = 'TRADE_CANDIDATE'
     and o.paper_position_id is null;

  if v_trace is null then
    raise exception 'paper_orchestration_missing: strategy DCA requires exact Council-Onyx approval'
      using errcode = 'check_violation';
  end if;
  new.onyx_decision_id := coalesce(new.onyx_decision_id, v_onyx);
  return new;
end;
$$;

revoke all on function public.paper_positions_require_orchestration()
  from public, anon, authenticated;
grant execute on function public.paper_positions_require_orchestration() to service_role;

-- Each role wallet compounds from its own realized results. This is separate
-- from the shared paper account ledger and applies to every future fill.
create or replace function public.paper_wallet_apply_trade_pnl()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.paper_wallets
     set balance = greatest(0, balance + coalesce(new.pnl_net, 0)),
         realized_pnl = realized_pnl + coalesce(new.pnl_net, 0),
         updated_at = now()
   where user_id = new.user_id
     and wallet_key = new.wallet_key;
  return null;
end;
$$;

revoke all on function public.paper_wallet_apply_trade_pnl()
  from public, anon, authenticated;
grant execute on function public.paper_wallet_apply_trade_pnl() to service_role;

drop trigger if exists paper_wallet_apply_trade_pnl_trg on public.paper_trades;
create trigger paper_wallet_apply_trade_pnl_trg
  after insert on public.paper_trades
  for each row execute function public.paper_wallet_apply_trade_pnl();
