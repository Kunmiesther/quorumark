-- Zen-valid sweep campaigns are deterministic. They must pass the shared
-- strategy contract and the normal portfolio/risk gates, but they do not
-- require an AI Council trace. All other strategies remain fail-closed on
-- the existing approved orchestration invariant.
do $$
begin
  if to_regclass('public.paper_ai_orchestrations') is null then
    raise exception
      'zen_sweep_authority_requires paper_ai_orchestrations; apply the orchestration foundation first';
  end if;

  if to_regprocedure('public.ensure_paper_wallets(uuid)') is null then
    raise exception
      'zen_sweep_authority_requires ensure_paper_wallets(uuid)';
  end if;
end;
$$;

create or replace function public.paper_positions_require_orchestration()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trace uuid;
  v_onyx uuid;
  v_is_zen_sweep boolean;
begin
  v_is_zen_sweep :=
    new.strategy = 'sweep'
    and new.opened_from_signal like '%:zen_sweep_v1:%'
    and new.symbol in ('BTC-USDT', 'XRP-USDT', 'SOL-USDT', 'ETH-USDT');

  if v_is_zen_sweep then
    new.orchestration_trace_id := null;
    new.onyx_decision_id := null;
    return new;
  end if;

  if new.orchestration_trace_id is null then
    select o.trace_id, o.onyx_decision_id
      into v_trace, v_onyx
      from public.paper_ai_orchestrations o
     where o.user_id = new.user_id
       and o.symbol = new.symbol
       and o.direction = new.direction
       and o.strategy = new.strategy
       and o.candle_ts_ms = new.entry_candle_ts_ms
       and o.record_kind = 'runtime'
       and o.snapshot_valid = true
       and o.providers_attempted >= 3
       and o.onyx_decision = 'enter'
       and o.gate_allowed = true
       and o.risk_checked = true
       and o.risk_passed = true
       and o.terminal_outcome = 'TRADE_CANDIDATE'
       and o.paper_position_id is null
     order by o.created_at desc
     limit 1;
    new.orchestration_trace_id := v_trace;
    if new.onyx_decision_id is null then new.onyx_decision_id := v_onyx; end if;
  else
    select o.trace_id, o.onyx_decision_id
      into v_trace, v_onyx
      from public.paper_ai_orchestrations o
     where o.trace_id = new.orchestration_trace_id
       and o.user_id = new.user_id
       and o.symbol = new.symbol
       and o.direction = new.direction
       and o.strategy = new.strategy
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
      raise exception 'paper_orchestration_invalid: supplied trace is not an unused approved runtime candidate'
        using errcode = 'check_violation';
    end if;
    if new.onyx_decision_id is null then new.onyx_decision_id := v_onyx; end if;
  end if;

  if new.orchestration_trace_id is null then
    raise exception 'paper_orchestration_missing: no exact approved AI orchestration trace'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Trigger functions are not application RPCs. Reassert the privilege after
-- replacement so CREATE OR REPLACE can never leave a directly callable
-- SECURITY DEFINER surface behind.
revoke all on function public.paper_positions_require_orchestration()
  from public, anon, authenticated;
grant execute on function public.paper_positions_require_orchestration()
  to service_role;

drop trigger if exists paper_positions_require_orchestration_trg
  on public.paper_positions;
create trigger paper_positions_require_orchestration_trg
  before insert on public.paper_positions
  for each row execute function public.paper_positions_require_orchestration();

-- The scan universe is a portfolio policy, not a strategy assignment.
-- Retain historical configuration rows for auditability, but only these four
-- may remain enabled.
update public.paper_test_symbols
   set enabled = symbol in ('BTC-USDT', 'XRP-USDT', 'SOL-USDT', 'ETH-USDT');

insert into public.paper_test_symbols
  (user_id, symbol, display_name, exchange, max_leverage, sort_order, enabled)
select a.user_id, s.symbol, split_part(s.symbol, '-', 1),
       'public_market_data', s.max_leverage, s.sort_order, true
  from public.paper_accounts a
 cross join (values
   ('BTC-USDT', 100, 1),
   ('XRP-USDT', 50, 2),
   ('SOL-USDT', 50, 3),
   ('ETH-USDT', 100, 4)
 ) as s(symbol, max_leverage, sort_order)
on conflict (user_id, symbol) do update
  set enabled = true,
      sort_order = excluded.sort_order;

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

-- This initializer is an internal engine operation. Its SECURITY DEFINER
-- authority is not exposed to browser roles; owner validation is still
-- performed by the established service path.
revoke all on function public.ensure_paper_wallets(uuid)
  from public, anon, authenticated;
grant execute on function public.ensure_paper_wallets(uuid)
  to service_role;
