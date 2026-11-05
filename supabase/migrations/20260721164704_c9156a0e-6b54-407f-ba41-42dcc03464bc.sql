-- Ladder-aware hard-stop invariant: audit fields + RPC updates
-- Phase 5B: strategy hard stop must NEVER close a laddered position while
-- fewer than the configured final rung have filled. Once the actual final
-- rung fills, arm the stop at exactly ±1% of that rung's ACTUAL fill price,
-- and persist an audit trail so a retry cannot arm or fire twice.

ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS hard_stop_armed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS final_rung_fill_price NUMERIC,
  ADD COLUMN IF NOT EXISTS armed_stop_price NUMERIC,
  ADD COLUMN IF NOT EXISTS ladder_contract_version INTEGER,
  ADD COLUMN IF NOT EXISTS armed_reason TEXT;

COMMENT ON COLUMN public.paper_positions.hard_stop_armed_at IS
  'When the strategy hard stop was armed. NULL until the ladder is fully filled. Idempotent: subsequent arm calls with the same values are no-ops.';
COMMENT ON COLUMN public.paper_positions.final_rung_fill_price IS
  'Actual fill price of the deepest rung at arming time. Never derived from initial entry, VWAP, or preplanned prices.';
COMMENT ON COLUMN public.paper_positions.armed_stop_price IS
  'Strategy hard stop price = final_rung_fill_price × (1 ± 0.01). Ladder positions only. NULL until armed.';
COMMENT ON COLUMN public.paper_positions.ladder_contract_version IS
  'Version of the ladder-hard-stop contract used to arm. Bumped when the invariant changes.';
COMMENT ON COLUMN public.paper_positions.armed_reason IS
  'Why arming happened. Current value: ladder_complete.';

-- Extend paper_open_position to allow ladder opens to force stop_level NULL
-- so a preplanned deepest-rung value cannot masquerade as an armed stop.
CREATE OR REPLACE FUNCTION public.paper_open_position(_user_id uuid, _wallet_id uuid, _payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pos_id uuid;
  v_is_ladder boolean := COALESCE((_payload->>'ladder_strategy')::boolean, false);
  v_stop_level numeric := CASE
    WHEN v_is_ladder THEN NULL
    ELSE (_payload->>'stop_level')::numeric
  END;
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
    v_stop_level,
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
$function$;

-- Extend paper_add_rung so the completing tick can arm the hard stop
-- atomically alongside the rung count/state update. Idempotent under
-- retry: the CAS on rung_count already prevents double-application, and
-- re-supplying the same arming values overwrites with identical data.
CREATE OR REPLACE FUNCTION public.paper_add_rung(_user_id uuid, _position_id uuid, _expected_rung_count integer, _new_state jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cur public.paper_positions%ROWTYPE;
  v_armed jsonb := _new_state->'armed';
  v_armed_at timestamptz := NULLIF(v_armed->>'armed_at','')::timestamptz;
  v_final_px numeric := NULLIF(v_armed->>'final_rung_fill_price','')::numeric;
  v_armed_stop numeric := NULLIF(v_armed->>'armed_stop_price','')::numeric;
  v_contract_ver integer := NULLIF(v_armed->>'contract_version','')::integer;
  v_armed_reason text := NULLIF(v_armed->>'reason','');
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
         last_seen_candle_ts_ms = NULLIF(_new_state->>'last_seen_candle_ts_ms','')::bigint,
         -- Arming fields: only set stop_level from armed_stop_price when arming
         -- payload is present. Non-arming rung fills leave stop_level untouched
         -- (NULL for ladder opens; unchanged for legacy rows).
         stop_level = CASE
           WHEN v_armed_stop IS NOT NULL THEN v_armed_stop
           ELSE stop_level
         END,
         hard_stop_armed_at = COALESCE(v_armed_at, hard_stop_armed_at),
         final_rung_fill_price = COALESCE(v_final_px, final_rung_fill_price),
         armed_stop_price = COALESCE(v_armed_stop, armed_stop_price),
         ladder_contract_version = COALESCE(v_contract_ver, ladder_contract_version),
         armed_reason = COALESCE(v_armed_reason, armed_reason)
   WHERE id = _position_id AND user_id = _user_id;

  RETURN jsonb_build_object('position_id', _position_id, 'rung_count', (_new_state->>'rung_count')::int);
END;
$function$;