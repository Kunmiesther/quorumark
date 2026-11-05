-- Phase 4B: atomic paper mutation RPCs.
CREATE OR REPLACE FUNCTION public._paper_assert_owner(_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_jwt_role   text := current_setting('request.jwt.claim.role', true);
  v_pg_role    text := current_setting('role', true);
  v_claims     text := current_setting('request.jwt.claims', true);
  v_is_service boolean := false;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'user_id required';
  END IF;
  IF COALESCE(v_jwt_role, '') = 'service_role'
     OR (v_claims IS NOT NULL AND v_claims::jsonb ->> 'role' = 'service_role')
     OR COALESCE(v_pg_role, '') = 'service_role'
  THEN
    v_is_service := true;
  END IF;
  IF NOT v_is_service THEN
    IF auth.uid() IS NULL OR auth.uid() <> _user_id THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._paper_assert_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._paper_assert_owner(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.paper_open_position(
  _user_id uuid,
  _wallet_id uuid,
  _payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pos_id uuid;
BEGIN
  PERFORM public._paper_assert_owner(_user_id);
  IF _wallet_id IS NULL OR _payload IS NULL THEN
    RAISE EXCEPTION 'wallet_id, payload required';
  END IF;

  PERFORM 1 FROM public.paper_wallets
    WHERE id = _wallet_id AND user_id = _user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wallet not found' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.paper_positions (
    user_id, wallet_key, symbol, direction, status,
    entry_price, entry_ts, entry_candle_ts_ms,
    tp_level, stop_level, zone_lower, zone_upper, zone_level,
    size_qty, size_notional, margin, leverage, entry_fee,
    opened_from_signal, last_seen_candle_ts_ms,
    trend_at_entry, trend_slope_pct_at_entry,
    strategy, regime_at_entry, onyx_rationale,
    rung_count, first_fill_vwap,
    fills, resize_levels, pending_rungs,
    ladder_total_margin, ladder_total_notional, ladder_total_rungs
  )
  SELECT
    _user_id,
    _payload->>'wallet_key',
    _payload->>'symbol',
    _payload->>'direction',
    'open',
    (_payload->>'entry_price')::numeric,
    (_payload->>'entry_ts')::timestamptz,
    (_payload->>'entry_candle_ts_ms')::bigint,
    NULLIF(_payload->>'tp_level','')::numeric,
    (_payload->>'stop_level')::numeric,
    (_payload->>'zone_lower')::numeric,
    (_payload->>'zone_upper')::numeric,
    (_payload->>'zone_level')::numeric,
    (_payload->>'size_qty')::numeric,
    (_payload->>'size_notional')::numeric,
    (_payload->>'margin')::numeric,
    (_payload->>'leverage')::numeric,
    (_payload->>'entry_fee')::numeric,
    NULLIF(_payload->>'opened_from_signal',''),
    (_payload->>'last_seen_candle_ts_ms')::bigint,
    NULLIF(_payload->>'trend_at_entry',''),
    NULLIF(_payload->>'trend_slope_pct_at_entry','')::numeric,
    COALESCE(_payload->>'strategy','accumulator'),
    NULLIF(_payload->>'regime_at_entry',''),
    NULLIF(_payload->>'onyx_rationale',''),
    COALESCE((_payload->>'rung_count')::int, 1),
    NULLIF(_payload->>'first_fill_vwap','')::numeric,
    COALESCE(_payload->'fills', '[]'::jsonb),
    COALESCE(_payload->'resize_levels', '[]'::jsonb),
    COALESCE(_payload->'pending_rungs', '[]'::jsonb),
    NULLIF(_payload->>'ladder_total_margin','')::numeric,
    NULLIF(_payload->>'ladder_total_notional','')::numeric,
    NULLIF(_payload->>'ladder_total_rungs','')::int
  RETURNING id INTO v_pos_id;

  UPDATE public.paper_wallets
     SET open_position_id = v_pos_id,
         last_tick_at = now()
   WHERE id = _wallet_id AND user_id = _user_id;

  RETURN jsonb_build_object('position_id', v_pos_id);
END;
$$;

REVOKE ALL ON FUNCTION public.paper_open_position(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.paper_open_position(uuid, uuid, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.paper_add_rung(
  _user_id uuid,
  _position_id uuid,
  _expected_rung_count int,
  _new_state jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cur public.paper_positions%ROWTYPE;
BEGIN
  PERFORM public._paper_assert_owner(_user_id);
  IF _position_id IS NULL OR _new_state IS NULL THEN
    RAISE EXCEPTION 'position_id, new_state required';
  END IF;

  SELECT * INTO v_cur FROM public.paper_positions
    WHERE id = _position_id AND user_id = _user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'position not found' USING ERRCODE = '42501';
  END IF;
  IF v_cur.status <> 'open' THEN
    RAISE EXCEPTION 'position not open';
  END IF;
  IF v_cur.rung_count <> _expected_rung_count THEN
    RAISE EXCEPTION 'rung_count CAS mismatch: got %, expected %',
      v_cur.rung_count, _expected_rung_count;
  END IF;

  UPDATE public.paper_positions
     SET entry_price = (_new_state->>'entry_price')::numeric,
         size_qty = (_new_state->>'size_qty')::numeric,
         size_notional = (_new_state->>'size_notional')::numeric,
         margin = (_new_state->>'margin')::numeric,
         entry_fee = (_new_state->>'entry_fee')::numeric,
         rung_count = (_new_state->>'rung_count')::int,
         tp_level = NULLIF(_new_state->>'tp_level','')::numeric,
         fills = COALESCE(_new_state->'fills', '[]'::jsonb),
         resize_levels = COALESCE(_new_state->'resize_levels', '[]'::jsonb),
         pending_rungs = COALESCE(_new_state->'pending_rungs', '[]'::jsonb),
         last_seen_candle_ts_ms = NULLIF(_new_state->>'last_seen_candle_ts_ms','')::bigint
   WHERE id = _position_id AND user_id = _user_id;

  RETURN jsonb_build_object('position_id', _position_id, 'rung_count', (_new_state->>'rung_count')::int);
END;
$$;

REVOKE ALL ON FUNCTION public.paper_add_rung(uuid, uuid, int, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.paper_add_rung(uuid, uuid, int, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.paper_reduce_position(
  _user_id uuid,
  _position_id uuid,
  _expected_rung_count int,
  _trade jsonb,
  _new_state jsonb,
  _account_delta numeric,
  _wallet_id uuid,
  _wallet_stats jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cur public.paper_positions%ROWTYPE;
  v_trade_id uuid;
BEGIN
  PERFORM public._paper_assert_owner(_user_id);
  IF _position_id IS NULL OR _trade IS NULL OR _new_state IS NULL THEN
    RAISE EXCEPTION 'position_id, trade, new_state required';
  END IF;

  SELECT * INTO v_cur FROM public.paper_positions
    WHERE id = _position_id AND user_id = _user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'position not found' USING ERRCODE = '42501';
  END IF;
  IF v_cur.status <> 'open' THEN
    RAISE EXCEPTION 'position not open';
  END IF;
  IF v_cur.rung_count <> _expected_rung_count THEN
    RAISE EXCEPTION 'rung_count CAS mismatch';
  END IF;

  INSERT INTO public.paper_trades (
    user_id, wallet_key, symbol, direction,
    entry_price, exit_price, exit_reason,
    size_qty, size_notional, margin, leverage,
    pnl_gross, fees, slippage_cost, pnl_net,
    hold_seconds, opened_at, closed_at, position_id
  ) VALUES (
    _user_id,
    _trade->>'wallet_key',
    _trade->>'symbol',
    _trade->>'direction',
    (_trade->>'entry_price')::numeric,
    (_trade->>'exit_price')::numeric,
    _trade->>'exit_reason',
    (_trade->>'size_qty')::numeric,
    (_trade->>'size_notional')::numeric,
    (_trade->>'margin')::numeric,
    (_trade->>'leverage')::numeric,
    (_trade->>'pnl_gross')::numeric,
    (_trade->>'fees')::numeric,
    (_trade->>'slippage_cost')::numeric,
    (_trade->>'pnl_net')::numeric,
    (_trade->>'hold_seconds')::int,
    (_trade->>'opened_at')::timestamptz,
    (_trade->>'closed_at')::timestamptz,
    _position_id
  ) RETURNING id INTO v_trade_id;

  UPDATE public.paper_positions
     SET entry_price = (_new_state->>'entry_price')::numeric,
         size_qty = (_new_state->>'size_qty')::numeric,
         size_notional = (_new_state->>'size_notional')::numeric,
         margin = (_new_state->>'margin')::numeric,
         entry_fee = (_new_state->>'entry_fee')::numeric,
         rung_count = (_new_state->>'rung_count')::int,
         tp_level = NULLIF(_new_state->>'tp_level','')::numeric,
         fills = COALESCE(_new_state->'fills', '[]'::jsonb),
         resize_levels = COALESCE(_new_state->'resize_levels', '[]'::jsonb),
         pending_rungs = COALESCE(_new_state->'pending_rungs', '[]'::jsonb),
         last_seen_candle_ts_ms = NULLIF(_new_state->>'last_seen_candle_ts_ms','')::bigint
   WHERE id = _position_id AND user_id = _user_id;

  IF _wallet_id IS NOT NULL AND _wallet_stats IS NOT NULL THEN
    UPDATE public.paper_wallets
       SET trades_count = COALESCE(trades_count,0) + COALESCE((_wallet_stats->>'trades_delta')::int, 0),
           wins_count   = COALESCE(wins_count,0)   + COALESCE((_wallet_stats->>'wins_delta')::int, 0),
           losses_count = COALESCE(losses_count,0) + COALESCE((_wallet_stats->>'losses_delta')::int, 0),
           last_tick_at = now()
     WHERE id = _wallet_id AND user_id = _user_id;
  END IF;

  UPDATE public.paper_accounts
     SET balance = balance + COALESCE(_account_delta, 0),
         realized_pnl = realized_pnl + COALESCE(_account_delta, 0)
   WHERE user_id = _user_id;

  RETURN jsonb_build_object('trade_id', v_trade_id, 'position_id', _position_id);
END;
$$;

REVOKE ALL ON FUNCTION public.paper_reduce_position(uuid, uuid, int, jsonb, jsonb, numeric, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.paper_reduce_position(uuid, uuid, int, jsonb, jsonb, numeric, uuid, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.paper_close_position(
  _user_id uuid,
  _position_id uuid,
  _last_seen_candle_ts_ms bigint,
  _trades jsonb,
  _account_delta numeric,
  _wallet_id uuid,
  _wallet_stats jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated int;
  v_trade jsonb;
  v_trade_ids uuid[] := ARRAY[]::uuid[];
  v_trade_id uuid;
BEGIN
  PERFORM public._paper_assert_owner(_user_id);
  IF _position_id IS NULL THEN
    RAISE EXCEPTION 'position_id required';
  END IF;

  UPDATE public.paper_positions
     SET status = 'closed',
         last_seen_candle_ts_ms = COALESCE(_last_seen_candle_ts_ms, last_seen_candle_ts_ms)
   WHERE id = _position_id
     AND user_id = _user_id
     AND status = 'open';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RETURN jsonb_build_object('already_closed', true, 'position_id', _position_id);
  END IF;

  IF _trades IS NOT NULL AND jsonb_typeof(_trades) = 'array' THEN
    FOR v_trade IN SELECT jsonb_array_elements(_trades) LOOP
      INSERT INTO public.paper_trades (
        user_id, wallet_key, symbol, direction,
        entry_price, exit_price, exit_reason,
        size_qty, size_notional, margin, leverage,
        pnl_gross, fees, slippage_cost, pnl_net,
        hold_seconds, opened_at, closed_at, position_id
      ) VALUES (
        _user_id,
        v_trade->>'wallet_key',
        v_trade->>'symbol',
        v_trade->>'direction',
        (v_trade->>'entry_price')::numeric,
        (v_trade->>'exit_price')::numeric,
        v_trade->>'exit_reason',
        (v_trade->>'size_qty')::numeric,
        (v_trade->>'size_notional')::numeric,
        (v_trade->>'margin')::numeric,
        (v_trade->>'leverage')::numeric,
        (v_trade->>'pnl_gross')::numeric,
        (v_trade->>'fees')::numeric,
        (v_trade->>'slippage_cost')::numeric,
        (v_trade->>'pnl_net')::numeric,
        (v_trade->>'hold_seconds')::int,
        (v_trade->>'opened_at')::timestamptz,
        (v_trade->>'closed_at')::timestamptz,
        _position_id
      ) RETURNING id INTO v_trade_id;
      v_trade_ids := v_trade_ids || v_trade_id;
    END LOOP;
  END IF;

  IF _wallet_id IS NOT NULL THEN
    UPDATE public.paper_wallets
       SET open_position_id = NULL,
           trades_count = COALESCE(trades_count,0) + COALESCE((_wallet_stats->>'trades_delta')::int, 0),
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
    'trade_ids', to_jsonb(v_trade_ids)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.paper_close_position(uuid, uuid, bigint, jsonb, numeric, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.paper_close_position(uuid, uuid, bigint, jsonb, numeric, uuid, jsonb) TO authenticated, service_role;
