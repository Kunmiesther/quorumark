
-- ── Index to keep the SKIP LOCKED claim scan cheap ────────────────────
CREATE INDEX IF NOT EXISTS paper_execution_slots_claim_idx
  ON public.paper_execution_slots (user_id, state, slot_index)
  WHERE state IN ('unassigned', 'reserved');

-- ── RPC: paper_assign_execution_slot ──────────────────────────────────
-- Atomically claim the lowest-index unassigned slot for (user, symbol, direction).
-- Returns the reserved slot_id, or NULL when the user has no free capacity.
-- Concurrency: FOR UPDATE SKIP LOCKED — two concurrent callers cannot
-- claim the same slot; each either gets a distinct slot or NULL.
-- Idempotency: passing a correlation_id that is already reserved for the
-- caller returns the same slot (so a retried tick does not double-book).
CREATE OR REPLACE FUNCTION public.paper_assign_execution_slot(
  _user_id         uuid,
  _symbol          text,
  _direction       text,
  _correlation_id  uuid,
  _ttl_secs        integer DEFAULT 300
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $fn$
DECLARE
  v_slot_id uuid;
BEGIN
  PERFORM public._paper_assert_owner(_user_id);
  IF _user_id IS NULL OR _symbol IS NULL OR _direction IS NULL
     OR _correlation_id IS NULL THEN
    RAISE EXCEPTION 'user_id, symbol, direction, correlation_id required'
      USING ERRCODE = '22023';
  END IF;
  IF _direction NOT IN ('long', 'short') THEN
    RAISE EXCEPTION 'direction must be long|short, got %', _direction
      USING ERRCODE = '22023';
  END IF;

  -- Idempotency: same correlation_id already holds a reserved slot? return it.
  SELECT id INTO v_slot_id
    FROM public.paper_execution_slots
   WHERE user_id       = _user_id
     AND correlation_id = _correlation_id
     AND state          = 'reserved'
     AND assigned_symbol   = _symbol
     AND assigned_direction = _direction
   LIMIT 1;
  IF v_slot_id IS NOT NULL THEN
    RETURN v_slot_id;
  END IF;

  -- Atomic claim: pick the lowest-index truly free slot.
  WITH candidate AS (
    SELECT id
      FROM public.paper_execution_slots
     WHERE user_id = _user_id
       AND state   = 'unassigned'
     ORDER BY slot_index
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  UPDATE public.paper_execution_slots s
     SET state                  = 'reserved',
         assigned_symbol        = _symbol,
         assigned_direction     = _direction,
         correlation_id         = _correlation_id,
         reservation_expires_at = now() + make_interval(secs => GREATEST(_ttl_secs, 10)),
         last_transition_at     = now(),
         capacity_version       = s.capacity_version + 1,
         updated_at             = now()
    FROM candidate c
   WHERE s.id = c.id
  RETURNING s.id INTO v_slot_id;

  RETURN v_slot_id; -- NULL means no free slot (fail-closed at caller)
END;
$fn$;

REVOKE ALL ON FUNCTION public.paper_assign_execution_slot(uuid, text, text, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.paper_assign_execution_slot(uuid, text, text, uuid, integer) TO authenticated, service_role;

-- ── RPC: paper_release_execution_slot ────────────────────────────────
-- Return a reserved slot to the pool. No-op if slot already advanced
-- (active/committed) — those are governed by close/reconcile paths.
CREATE OR REPLACE FUNCTION public.paper_release_execution_slot(
  _user_id  uuid,
  _slot_id  uuid,
  _reason   text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $fn$
DECLARE
  v_released boolean := false;
BEGIN
  PERFORM public._paper_assert_owner(_user_id);
  IF _slot_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.paper_execution_slots
     SET state                  = 'unassigned',
         assigned_symbol        = NULL,
         assigned_direction     = NULL,
         correlation_id         = NULL,
         reservation_expires_at = NULL,
         position_id            = NULL,
         last_transition_at     = now(),
         capacity_version       = capacity_version + 1,
         detail                 = COALESCE(detail, '{}'::jsonb)
                                  || jsonb_build_object('last_release_reason', COALESCE(_reason, 'unspecified'),
                                                        'last_release_at', to_jsonb(now())),
         updated_at             = now()
   WHERE id      = _slot_id
     AND user_id = _user_id
     AND state   = 'reserved';

  GET DIAGNOSTICS v_released = ROW_COUNT;
  RETURN v_released;
END;
$fn$;

REVOKE ALL ON FUNCTION public.paper_release_execution_slot(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.paper_release_execution_slot(uuid, uuid, text) TO authenticated, service_role;

-- ── RPC: paper_sweep_expired_slot_reservations ───────────────────────
-- Reclaim slots whose reservation TTL elapsed with no position created.
CREATE OR REPLACE FUNCTION public.paper_sweep_expired_slot_reservations(
  _user_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $fn$
DECLARE
  v_count integer;
BEGIN
  IF _user_id IS NOT NULL THEN
    PERFORM public._paper_assert_owner(_user_id);
  END IF;

  UPDATE public.paper_execution_slots
     SET state                  = 'unassigned',
         assigned_symbol        = NULL,
         assigned_direction     = NULL,
         correlation_id         = NULL,
         reservation_expires_at = NULL,
         last_transition_at     = now(),
         capacity_version       = capacity_version + 1,
         updated_at             = now()
   WHERE state = 'reserved'
     AND reservation_expires_at IS NOT NULL
     AND reservation_expires_at < now()
     AND (_user_id IS NULL OR user_id = _user_id);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$fn$;

REVOKE ALL ON FUNCTION public.paper_sweep_expired_slot_reservations(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.paper_sweep_expired_slot_reservations(uuid) TO authenticated, service_role;

-- ── Extend paper_open_position to accept slot_id and promote the slot ─
-- New behavior:
--   1. If _payload contains slot_id, verify it belongs to the caller,
--      is in state 'reserved' with matching symbol/direction, and pin it
--      onto the new position row.
--   2. Promote the slot to state 'active' + record position_id in the
--      SAME transaction as the insert. Any failure rolls back both.
--   3. If no slot_id is supplied, behavior is unchanged — the authority
--      guard trigger still fails-closed for dynamic_universe users.
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
  v_configured int := NULLIF(_payload->>'ladder_total_rungs','')::int;
  v_initial_fills jsonb := COALESCE(_payload->'fills', '[]'::jsonb);
  v_first_fill jsonb;
  v_slot_id uuid := NULLIF(_payload->>'slot_id','')::uuid;
  v_slot_state paper_slot_state;
  v_slot_symbol text;
  v_slot_direction text;
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

  -- Verify + lock the slot BEFORE insert, so trigger sees a valid reserved slot.
  IF v_slot_id IS NOT NULL THEN
    SELECT state, assigned_symbol, assigned_direction
      INTO v_slot_state, v_slot_symbol, v_slot_direction
      FROM public.paper_execution_slots
     WHERE id = v_slot_id AND user_id = _user_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'paper_open_position: slot % not found for user %', v_slot_id, _user_id
        USING ERRCODE = '42501';
    END IF;
    IF v_slot_state <> 'reserved' THEN
      RAISE EXCEPTION 'paper_open_position: slot % in state % (expected reserved)', v_slot_id, v_slot_state
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_slot_symbol IS DISTINCT FROM (_payload->>'symbol')
       OR v_slot_direction IS DISTINCT FROM (_payload->>'direction') THEN
      RAISE EXCEPTION 'paper_open_position: slot % assigned %/% mismatches payload %/%',
        v_slot_id, v_slot_symbol, v_slot_direction,
        _payload->>'symbol', _payload->>'direction'
        USING ERRCODE = 'check_violation';
    END IF;
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
    ladder_total_margin, ladder_total_notional, ladder_total_rungs,
    configured_rung_count, filled_rung_count,
    slot_id
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
    v_initial_fills,
    COALESCE(_payload->'resize_levels', '[]'::jsonb),
    COALESCE(_payload->'pending_rungs', '[]'::jsonb),
    NULLIF(_payload->>'ladder_total_margin','')::numeric,
    NULLIF(_payload->>'ladder_total_notional','')::numeric,
    v_configured,
    v_configured,
    COALESCE((_payload->>'rung_count')::int, 1),
    v_slot_id
  RETURNING id INTO v_pos_id;

  UPDATE public.paper_wallets
     SET open_position_id = v_pos_id,
         last_tick_at = now()
   WHERE id = _wallet_id AND user_id = _user_id;

  -- Promote slot to active in the same transaction.
  IF v_slot_id IS NOT NULL THEN
    UPDATE public.paper_execution_slots
       SET state                  = 'active',
           position_id            = v_pos_id,
           reservation_expires_at = NULL,
           last_transition_at     = now(),
           capacity_version       = capacity_version + 1,
           updated_at             = now()
     WHERE id = v_slot_id AND user_id = _user_id;
  END IF;

  IF jsonb_array_length(v_initial_fills) > 0 THEN
    v_first_fill := v_initial_fills->0;
    IF (v_first_fill->>'price') IS NOT NULL THEN
      INSERT INTO public.paper_rung_fills (
        user_id, position_id, rung_index,
        fill_price, qty, margin, tp_price, fill_status, filled_at, candle_ts_ms
      ) VALUES (
        _user_id, v_pos_id, 1,
        (v_first_fill->>'price')::numeric,
        COALESCE((v_first_fill->>'qty')::numeric, 0),
        COALESCE((v_first_fill->>'margin')::numeric, 0),
        COALESCE((v_first_fill->>'tp')::numeric, 0),
        'filled',
        (_payload->>'entry_ts')::timestamptz,
        (_payload->>'entry_candle_ts_ms')::bigint
      )
      ON CONFLICT (position_id, rung_index) DO NOTHING;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'position_id', v_pos_id,
    'slot_id', v_slot_id
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.paper_open_position(uuid, uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.paper_open_position(uuid, uuid, jsonb) TO authenticated, service_role;
