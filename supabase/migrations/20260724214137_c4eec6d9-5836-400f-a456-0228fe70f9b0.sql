
-- 1) Extend paper_positions with promotion state
ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS promoted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS promoted_at timestamptz,
  ADD COLUMN IF NOT EXISTS runner_breakeven_stop numeric,
  ADD COLUMN IF NOT EXISTS banked_qty numeric,
  ADD COLUMN IF NOT EXISTS banked_pnl_net numeric;

-- 2) Extend paper_trades exit_reason CHECK
ALTER TABLE public.paper_trades DROP CONSTRAINT IF EXISTS paper_trades_exit_reason_check;
ALTER TABLE public.paper_trades ADD CONSTRAINT paper_trades_exit_reason_check
  CHECK (exit_reason = ANY (ARRAY[
    'tp_touch','stop','floor','scout_bos','paper_reset',
    'scout_guardian_bos','scout_guardian_cluster',
    'htf_promotion_bank','htf_bos_exit','runner_breakeven_stop'
  ]));

-- 3) Atomic partial-close RPC (banks a slice, keeps position open, applies promotion patch)
CREATE OR REPLACE FUNCTION public.paper_partial_close_position(
  _user_id uuid,
  _position_id uuid,
  _last_seen_candle_ts_ms bigint,
  _trade jsonb,
  _size_qty_delta numeric,
  _size_notional_delta numeric,
  _margin_delta numeric,
  _account_delta numeric,
  _wallet_id uuid,
  _wallet_stats jsonb,
  _position_patch jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_trade_id uuid;
  v_pos public.paper_positions%ROWTYPE;
  v_new_qty numeric;
BEGIN
  PERFORM public._paper_assert_owner(_user_id);
  IF _position_id IS NULL THEN
    RAISE EXCEPTION 'position_id required';
  END IF;

  SELECT * INTO v_pos FROM public.paper_positions
    WHERE id = _position_id AND user_id = _user_id AND status = 'open'
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('already_closed', true, 'position_id', _position_id);
  END IF;

  v_new_qty := v_pos.size_qty - COALESCE(_size_qty_delta, 0);
  IF v_new_qty <= 0 THEN
    RAISE EXCEPTION 'partial close would leave non-positive qty (start=%, delta=%)', v_pos.size_qty, _size_qty_delta;
  END IF;

  -- Bank slice as a paper_trades row
  INSERT INTO public.paper_trades (
    user_id, wallet_key, symbol, direction,
    entry_price, exit_price, exit_reason,
    size_qty, size_notional, margin, leverage,
    pnl_gross, fees, slippage_cost, pnl_net,
    hold_seconds, opened_at, closed_at, position_id
  ) VALUES (
    _user_id,
    _trade->>'wallet_key', _trade->>'symbol', _trade->>'direction',
    (_trade->>'entry_price')::numeric, (_trade->>'exit_price')::numeric, _trade->>'exit_reason',
    (_trade->>'size_qty')::numeric, (_trade->>'size_notional')::numeric,
    (_trade->>'margin')::numeric, (_trade->>'leverage')::numeric,
    (_trade->>'pnl_gross')::numeric, (_trade->>'fees')::numeric,
    (_trade->>'slippage_cost')::numeric, (_trade->>'pnl_net')::numeric,
    (_trade->>'hold_seconds')::int,
    (_trade->>'opened_at')::timestamptz, (_trade->>'closed_at')::timestamptz,
    _position_id
  ) RETURNING id INTO v_trade_id;

  -- Decrement position size + apply promotion patch atomically.
  -- _position_patch keys: promoted, promoted_at, runner_breakeven_stop,
  -- stop_level (nullable), tp_level (nullable), pending_rungs (jsonb array),
  -- banked_qty_add, banked_pnl_net_add.
  UPDATE public.paper_positions
    SET size_qty = v_new_qty,
        size_notional = GREATEST(0::numeric, size_notional - COALESCE(_size_notional_delta, 0)),
        margin = GREATEST(0::numeric, margin - COALESCE(_margin_delta, 0)),
        last_seen_candle_ts_ms = COALESCE(_last_seen_candle_ts_ms, last_seen_candle_ts_ms),
        promoted = COALESCE((_position_patch->>'promoted')::boolean, promoted),
        promoted_at = COALESCE((_position_patch->>'promoted_at')::timestamptz, promoted_at),
        runner_breakeven_stop = COALESCE((_position_patch->>'runner_breakeven_stop')::numeric, runner_breakeven_stop),
        banked_qty = COALESCE(banked_qty, 0) + COALESCE((_position_patch->>'banked_qty_add')::numeric, 0),
        banked_pnl_net = COALESCE(banked_pnl_net, 0) + COALESCE((_position_patch->>'banked_pnl_net_add')::numeric, 0),
        stop_level = CASE WHEN _position_patch ? 'stop_level'
                          THEN NULLIF(_position_patch->>'stop_level','')::numeric
                          ELSE stop_level END,
        tp_level = CASE WHEN _position_patch ? 'tp_level'
                        THEN NULLIF(_position_patch->>'tp_level','')::numeric
                        ELSE tp_level END,
        pending_rungs = CASE WHEN _position_patch ? 'pending_rungs'
                             THEN _position_patch->'pending_rungs'
                             ELSE pending_rungs END,
        updated_at = now()
    WHERE id = _position_id AND user_id = _user_id AND status = 'open';

  IF _wallet_id IS NOT NULL THEN
    UPDATE public.paper_wallets
      SET trades_count = COALESCE(trades_count,0) + COALESCE((_wallet_stats->>'trades_delta')::int, 0),
          wins_count   = COALESCE(wins_count,0)   + COALESCE((_wallet_stats->>'wins_delta')::int, 0),
          losses_count = COALESCE(losses_count,0) + COALESCE((_wallet_stats->>'losses_delta')::int, 0),
          last_processed_candle_ts_ms = COALESCE(_last_seen_candle_ts_ms, last_processed_candle_ts_ms),
          last_tick_at = now()
      WHERE id = _wallet_id AND user_id = _user_id;
  END IF;

  IF COALESCE(_account_delta, 0) <> 0 THEN
    UPDATE public.paper_accounts
      SET balance = balance + _account_delta,
          realized_pnl = realized_pnl + _account_delta
      WHERE user_id = _user_id;
  END IF;

  RETURN jsonb_build_object(
    'already_closed', false,
    'position_id', _position_id,
    'trade_id', v_trade_id,
    'remaining_qty', v_new_qty
  );
END;
$fn$;
