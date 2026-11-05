-- The engine emits these exit reasons; rejecting them rolls back financial exits.
alter table public.paper_trades drop constraint paper_trades_exit_reason_check;
alter table public.paper_trades add constraint paper_trades_exit_reason_check
check (exit_reason in ('tp_touch', 'stop', 'floor', 'scout_bos', 'paper_reset',
  'scout_guardian_bos', 'scout_guardian_cluster', 'htf_promotion_bank',
  'htf_bos_exit', 'runner_breakeven_stop', 'zen_tp1', 'zen_tp2', 'zen_trailing'));

-- Retain the RPC signature, authority checks and grants. Legacy callers may
-- still submit a single trade; new callers submit all partial-exit lots together.
CREATE OR REPLACE FUNCTION public.paper_reduce_position(_user_id uuid, _position_id uuid, _expected_rung_count integer, _trade jsonb, _new_state jsonb, _account_delta numeric, _wallet_id uuid, _wallet_stats jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_position public.paper_positions%rowtype; v_trade_id uuid; v_trade jsonb;
  v_trade_ids uuid[] := array[]::uuid[]; v_trades jsonb;
begin
  perform public._paper_assert_owner(_user_id);
  select * into v_position from public.paper_positions
   where id = _position_id and user_id = _user_id and status = 'open' for update;
  if not found then raise exception 'paper_position_unavailable'; end if;
  if v_position.rung_count <> _expected_rung_count then raise exception 'paper_rung_conflict'; end if;
  v_trades := case when jsonb_typeof(_trade) = 'array' then _trade else jsonb_build_array(_trade) end;
  if jsonb_array_length(v_trades) = 0 then raise exception 'paper_empty_reduction'; end if;
  if _new_state ? 'strategy_metadata' and jsonb_typeof(_new_state->'strategy_metadata') <> 'object' then
    raise exception 'paper_invalid_strategy_metadata';
  end if;
  for v_trade in select value from jsonb_array_elements(v_trades) loop
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
  v_trade_ids := array_append(v_trade_ids, v_trade_id);
  end loop;
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
    strategy_metadata = coalesce(_new_state->'strategy_metadata', strategy_metadata),
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
  return jsonb_build_object('trade_id', v_trade_ids[1], 'trade_ids', v_trade_ids, 'position_id', _position_id);
end;
$function$
;

-- Repair derived flags only when no corresponding successful TP1 exists.
-- Never synthesize a trade or alter a historical financial amount.
update public.paper_positions p
set strategy_metadata = jsonb_set(p.strategy_metadata, '{first_target_taken}', 'false'::jsonb)
where p.status = 'open'
  and p.strategy_metadata->>'contract_id' = 'zen_sweep_v1'
  and p.strategy_metadata->>'first_target_taken' = 'true'
  and not exists (
    select 1 from public.paper_trades t
    where t.position_id = p.id and t.exit_reason = 'zen_tp1'
  );
