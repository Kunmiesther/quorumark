CREATE OR REPLACE FUNCTION public.paper_positions_require_orchestration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trace uuid;
  v_onyx uuid;
BEGIN
  IF NEW.orchestration_trace_id IS NULL THEN
    SELECT o.trace_id, o.onyx_decision_id
      INTO v_trace, v_onyx
      FROM public.paper_ai_orchestrations o
     WHERE o.user_id = NEW.user_id
       AND o.symbol = NEW.symbol
       AND o.direction = NEW.direction
       AND o.strategy = NEW.strategy
       AND o.candle_ts_ms = NEW.entry_candle_ts_ms
       AND o.record_kind = 'runtime'
       AND o.snapshot_valid = true
       AND o.providers_attempted >= 3
       AND o.onyx_decision = 'enter'
       AND o.gate_allowed = true
       AND o.risk_checked = true
       AND o.risk_passed = true
       AND o.terminal_outcome = 'TRADE_CANDIDATE'
       AND o.paper_position_id IS NULL
     ORDER BY o.created_at DESC
     LIMIT 1;
    NEW.orchestration_trace_id := v_trace;
    IF NEW.onyx_decision_id IS NULL THEN NEW.onyx_decision_id := v_onyx; END IF;
  ELSE
    SELECT o.trace_id, o.onyx_decision_id
      INTO v_trace, v_onyx
      FROM public.paper_ai_orchestrations o
     WHERE o.trace_id = NEW.orchestration_trace_id
       AND o.user_id = NEW.user_id
       AND o.symbol = NEW.symbol
       AND o.direction = NEW.direction
       AND o.strategy = NEW.strategy
       AND o.candle_ts_ms = NEW.entry_candle_ts_ms
       AND o.record_kind = 'runtime'
       AND o.snapshot_valid = true
       AND o.providers_attempted >= 3
       AND o.onyx_decision = 'enter'
       AND o.gate_allowed = true
       AND o.risk_checked = true
       AND o.risk_passed = true
       AND o.terminal_outcome = 'TRADE_CANDIDATE'
       AND o.paper_position_id IS NULL;
    IF v_trace IS NULL THEN
      RAISE EXCEPTION 'paper_orchestration_invalid: supplied trace is not an unused approved runtime candidate'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.onyx_decision_id IS NULL THEN NEW.onyx_decision_id := v_onyx; END IF;
  END IF;

  IF NEW.orchestration_trace_id IS NULL THEN
    RAISE EXCEPTION 'paper_orchestration_missing: no exact approved AI orchestration trace'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.paper_open_position(_user_id uuid, _wallet_id uuid, _payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pos_id uuid;
  v_is_ladder boolean := COALESCE((_payload->>'ladder_strategy')::boolean, false);
  v_stop_level numeric := CASE WHEN v_is_ladder THEN NULL ELSE NULLIF(_payload->>'stop_level','')::numeric END;
  v_configured int := NULLIF(_payload->>'ladder_total_rungs','')::int;
  v_initial_fills jsonb := COALESCE(_payload->'fills', '[]'::jsonb);
  v_first_fill jsonb;
  v_slot_id uuid := NULLIF(_payload->>'slot_id','')::uuid;
  v_auth_id uuid := NULLIF(_payload->>'authorization_id','')::uuid;
  v_pod_id uuid := NULLIF(_payload->>'pod_id','')::uuid;
  v_leg_id uuid := NULLIF(_payload->>'leg_id','')::uuid;
  v_trace_id uuid := NULLIF(_payload->>'orchestration_trace_id','')::uuid;
  v_onyx_id uuid := NULLIF(_payload->>'onyx_decision_id','')::uuid;
  v_leg_state text;
  v_leg_dir text;
  v_leg_symbol text;
  v_leg_auth uuid;
  v_leg_pod uuid;
  v_authority_mode text;
BEGIN
  PERFORM public._paper_assert_owner(_user_id);
  IF _wallet_id IS NULL OR _payload IS NULL THEN
    RAISE EXCEPTION 'paper_open_invalid: wallet_id and payload required' USING ERRCODE='22023';
  END IF;

  PERFORM 1 FROM public.paper_wallets WHERE id=_wallet_id AND user_id=_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'paper_wallet_missing: owned wallet not found' USING ERRCODE='42501'; END IF;

  SELECT mode INTO v_authority_mode FROM public.paper_engine_authority WHERE user_id=_user_id;

  IF v_leg_id IS NOT NULL THEN
    SELECT state, leg_direction, assigned_symbol, authorization_id, pod_id
      INTO v_leg_state, v_leg_dir, v_leg_symbol, v_leg_auth, v_leg_pod
      FROM public.paper_wallet_legs
     WHERE id=v_leg_id AND user_id=_user_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'paper_leg_missing: reserved leg not found' USING ERRCODE='42501'; END IF;
    IF v_leg_state <> 'reserved' THEN RAISE EXCEPTION 'paper_leg_not_reserved: expected reserved leg' USING ERRCODE='check_violation'; END IF;
    IF v_leg_dir IS DISTINCT FROM (_payload->>'direction') OR v_leg_symbol IS DISTINCT FROM (_payload->>'symbol') THEN
      RAISE EXCEPTION 'paper_leg_mismatch: reserved leg differs from payload' USING ERRCODE='check_violation';
    END IF;
    IF v_auth_id IS NOT NULL AND v_leg_auth IS DISTINCT FROM v_auth_id THEN
      RAISE EXCEPTION 'paper_authorization_mismatch: leg authorization differs' USING ERRCODE='check_violation';
    END IF;
    IF v_auth_id IS NULL THEN v_auth_id := v_leg_auth; END IF;
    IF v_pod_id IS NULL THEN v_pod_id := v_leg_pod; END IF;
  END IF;

  IF v_authority_mode = 'dynamic_universe' THEN
    IF v_auth_id IS NULL THEN RAISE EXCEPTION 'paper_authority_missing: dynamic universe requires authorization' USING ERRCODE='check_violation'; END IF;
    IF v_leg_id IS NULL THEN RAISE EXCEPTION 'paper_leg_required: dynamic universe requires reserved leg' USING ERRCODE='check_violation'; END IF;
  END IF;

  INSERT INTO public.paper_positions (
    user_id, wallet_key, symbol, direction, status,
    entry_price, entry_ts, entry_candle_ts_ms,
    tp_level, stop_level, zone_lower, zone_upper, zone_level,
    size_qty, size_notional, margin, leverage, entry_fee,
    opened_from_signal, last_seen_candle_ts_ms,
    trend_at_entry, trend_slope_pct_at_entry,
    strategy, regime_at_entry, onyx_rationale,
    rung_count, first_fill_vwap, fills, resize_levels, pending_rungs,
    ladder_total_margin, ladder_total_notional, ladder_total_rungs,
    configured_rung_count, filled_rung_count,
    slot_id, authorization_id, pod_id, leg_id,
    orchestration_trace_id, onyx_decision_id
  ) SELECT
    _user_id, _payload->>'wallet_key', _payload->>'symbol', _payload->>'direction', 'open',
    (_payload->>'entry_price')::numeric, (_payload->>'entry_ts')::timestamptz,
    (_payload->>'entry_candle_ts_ms')::bigint,
    NULLIF(_payload->>'tp_level','')::numeric, v_stop_level,
    NULLIF(_payload->>'zone_lower','')::numeric, NULLIF(_payload->>'zone_upper','')::numeric,
    NULLIF(_payload->>'zone_level','')::numeric,
    (_payload->>'size_qty')::numeric, (_payload->>'size_notional')::numeric,
    (_payload->>'margin')::numeric, (_payload->>'leverage')::numeric, (_payload->>'entry_fee')::numeric,
    NULLIF(_payload->>'opened_from_signal',''), (_payload->>'last_seen_candle_ts_ms')::bigint,
    NULLIF(_payload->>'trend_at_entry',''), NULLIF(_payload->>'trend_slope_pct_at_entry','')::numeric,
    COALESCE(_payload->>'strategy','accumulator'), NULLIF(_payload->>'regime_at_entry',''),
    NULLIF(_payload->>'onyx_rationale',''), COALESCE((_payload->>'rung_count')::int,1),
    NULLIF(_payload->>'first_fill_vwap','')::numeric, v_initial_fills,
    COALESCE(_payload->'resize_levels','[]'::jsonb), COALESCE(_payload->'pending_rungs','[]'::jsonb),
    NULLIF(_payload->>'ladder_total_margin','')::numeric,
    NULLIF(_payload->>'ladder_total_notional','')::numeric,
    v_configured, v_configured, COALESCE((_payload->>'rung_count')::int,1),
    v_slot_id, v_auth_id, v_pod_id, v_leg_id, v_trace_id, v_onyx_id
  RETURNING id INTO v_pos_id;

  UPDATE public.paper_wallets SET open_position_id=v_pos_id, last_tick_at=now()
   WHERE id=_wallet_id AND user_id=_user_id;

  IF v_leg_id IS NOT NULL THEN
    UPDATE public.paper_wallet_legs SET state='active', position_id=v_pos_id,
      reservation_expires_at=NULL, last_transition_at=now()
    WHERE id=v_leg_id AND user_id=_user_id;
  END IF;
  IF v_slot_id IS NOT NULL THEN
    UPDATE public.paper_execution_slots SET state='active', position_id=v_pos_id,
      reservation_expires_at=NULL, last_transition_at=now(), capacity_version=capacity_version+1
    WHERE id=v_slot_id AND user_id=_user_id;
  END IF;
  IF v_auth_id IS NOT NULL THEN
    UPDATE public.paper_authorizations SET consumed_position_id=v_pos_id, updated_at=now()
    WHERE id=v_auth_id AND user_id=_user_id;
  END IF;

  IF jsonb_array_length(v_initial_fills) > 0 THEN
    v_first_fill := v_initial_fills->0;
    IF (v_first_fill->>'price') IS NOT NULL THEN
      INSERT INTO public.paper_rung_fills (
        user_id, position_id, rung_index, fill_price, qty, margin, tp_price,
        fill_status, filled_at, candle_ts_ms
      ) VALUES (
        _user_id, v_pos_id, 1, (v_first_fill->>'price')::numeric,
        COALESCE((v_first_fill->>'qty')::numeric,0), COALESCE((v_first_fill->>'margin')::numeric,0),
        COALESCE((v_first_fill->>'tp')::numeric,0), 'filled',
        (_payload->>'entry_ts')::timestamptz, (_payload->>'entry_candle_ts_ms')::bigint
      ) ON CONFLICT (position_id, rung_index) DO NOTHING;
    END IF;
  END IF;

  RETURN jsonb_build_object('position_id',v_pos_id,'slot_id',v_slot_id,
    'authorization_id',v_auth_id,'pod_id',v_pod_id,'leg_id',v_leg_id,
    'orchestration_trace_id',v_trace_id);
END;
$$;

REVOKE ALL ON FUNCTION public.paper_open_position(uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.paper_open_position(uuid, uuid, jsonb) TO authenticated, service_role;