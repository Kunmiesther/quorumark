-- Rung persistence repair (Phase: authoritative rung identity)
-- Adds explicit configured_rung_count vs filled_rung_count, a durable
-- rung-identity table with a unique (position_id, rung_index) key, and
-- updates paper_open_position + paper_add_rung so:
--   * every rung fill is idempotent (ON CONFLICT DO NOTHING)
--   * filled_rung_count is derived from persisted identities, never client counts
--   * hard-stop arming is server-authoritative (fires ONLY when filled = configured)
-- Backfill is idempotent (safe to re-run) and never double-counts.

ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS configured_rung_count integer,
  ADD COLUMN IF NOT EXISTS filled_rung_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.paper_rung_fills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  position_id uuid NOT NULL REFERENCES public.paper_positions(id) ON DELETE CASCADE,
  rung_index integer NOT NULL CHECK (rung_index >= 1),
  fill_price numeric NOT NULL CHECK (fill_price > 0),
  qty numeric NOT NULL CHECK (qty >= 0),
  margin numeric NOT NULL DEFAULT 0,
  tp_price numeric NOT NULL DEFAULT 0,
  fill_status text NOT NULL DEFAULT 'filled'
    CHECK (fill_status IN ('filled','cancelled','rejected')),
  filled_at timestamptz NOT NULL DEFAULT now(),
  candle_ts_ms bigint,
  UNIQUE (position_id, rung_index)
);

GRANT SELECT, INSERT ON public.paper_rung_fills TO authenticated;
GRANT ALL ON public.paper_rung_fills TO service_role;

ALTER TABLE public.paper_rung_fills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own rung fills"
  ON public.paper_rung_fills
  FOR SELECT
  USING (auth.uid() = user_id);

-- Inserts happen through paper_open_position / paper_add_rung SECURITY
-- DEFINER RPCs; deny direct authenticated INSERT/UPDATE/DELETE to prevent
-- clients from manufacturing rung identities out-of-band.

CREATE INDEX IF NOT EXISTS paper_rung_fills_position_idx
  ON public.paper_rung_fills (position_id, rung_index);

-- ── Backfill: idempotent ───────────────────────────────────────────────

-- configured_rung_count from the planned ladder size at open.
UPDATE public.paper_positions
   SET configured_rung_count = COALESCE(configured_rung_count, ladder_total_rungs, NULLIF(rung_count, 0), 1)
 WHERE configured_rung_count IS NULL;

-- Backfill rung identities from paper_positions.fills[]. Deterministic:
-- WITH ORDINALITY assigns rung_index = array position (1..N). ON CONFLICT
-- DO NOTHING guarantees a second run inserts zero rows.
INSERT INTO public.paper_rung_fills (
  user_id, position_id, rung_index, fill_price, qty, margin, tp_price, fill_status, filled_at, candle_ts_ms
)
SELECT p.user_id,
       p.id,
       ord::int,
       (f.value->>'price')::numeric,
       COALESCE((f.value->>'qty')::numeric, 0),
       COALESCE((f.value->>'margin')::numeric, 0),
       COALESCE((f.value->>'tp')::numeric, 0),
       'filled',
       p.entry_ts,
       p.entry_candle_ts_ms
  FROM public.paper_positions p
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.fills, '[]'::jsonb))
                    WITH ORDINALITY AS f(value, ord)
 WHERE jsonb_array_length(COALESCE(p.fills, '[]'::jsonb)) > 0
   AND (f.value->>'price') IS NOT NULL
   AND (f.value->>'price')::numeric > 0
ON CONFLICT (position_id, rung_index) DO NOTHING;

-- Refresh filled_rung_count from the authoritative table.
UPDATE public.paper_positions p
   SET filled_rung_count = sub.c
  FROM (
    SELECT position_id, count(*)::int AS c
      FROM public.paper_rung_fills
     WHERE fill_status = 'filled'
     GROUP BY position_id
  ) sub
 WHERE p.id = sub.position_id
   AND p.filled_rung_count IS DISTINCT FROM sub.c;

-- ── RPC: paper_add_rung — authoritative rung write ────────────────────

CREATE OR REPLACE FUNCTION public.paper_add_rung(
  _user_id uuid,
  _position_id uuid,
  _expected_rung_count integer,
  _new_state jsonb,
  _rung_fills jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cur public.paper_positions%ROWTYPE;
  v_row jsonb;
  v_new_filled int;
  v_configured int;
  v_armed jsonb := _new_state->'armed';
  v_armed_at timestamptz := NULLIF(v_armed->>'armed_at','')::timestamptz;
  v_final_px numeric := NULLIF(v_armed->>'final_rung_fill_price','')::numeric;
  v_armed_stop numeric := NULLIF(v_armed->>'armed_stop_price','')::numeric;
  v_contract_ver int := NULLIF(v_armed->>'contract_version','')::integer;
  v_armed_reason text := NULLIF(v_armed->>'reason','');
  v_should_arm boolean;
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

  -- Idempotent rung inserts keyed by (position_id, rung_index). Retries
  -- and concurrent duplicates collapse to a single row per rung_index.
  IF _rung_fills IS NOT NULL AND jsonb_typeof(_rung_fills) = 'array' THEN
    FOR v_row IN SELECT jsonb_array_elements(_rung_fills) LOOP
      IF (v_row->>'rung_index') IS NULL OR (v_row->>'price') IS NULL THEN
        CONTINUE;
      END IF;
      INSERT INTO public.paper_rung_fills (
        user_id, position_id, rung_index,
        fill_price, qty, margin, tp_price, fill_status, filled_at, candle_ts_ms
      ) VALUES (
        _user_id, _position_id,
        (v_row->>'rung_index')::int,
        (v_row->>'price')::numeric,
        COALESCE((v_row->>'qty')::numeric, 0),
        COALESCE((v_row->>'margin')::numeric, 0),
        COALESCE((v_row->>'tp')::numeric, 0),
        COALESCE(NULLIF(v_row->>'fill_status',''), 'filled'),
        COALESCE(NULLIF(v_row->>'filled_at','')::timestamptz, now()),
        NULLIF(v_row->>'candle_ts_ms','')::bigint
      )
      ON CONFLICT (position_id, rung_index) DO NOTHING;
    END LOOP;
  END IF;

  -- Authoritative filled count from persisted identities. Ignores any
  -- client-supplied rung_count for the arming decision.
  SELECT count(*) INTO v_new_filled
    FROM public.paper_rung_fills
   WHERE position_id = _position_id AND fill_status = 'filled';

  v_configured := COALESCE(v_cur.configured_rung_count, v_cur.ladder_total_rungs, v_cur.rung_count);
  v_should_arm := v_configured IS NOT NULL AND v_new_filled >= v_configured;

  UPDATE public.paper_positions
     SET entry_price = (_new_state->>'entry_price')::numeric,
         size_qty = (_new_state->>'size_qty')::numeric,
         size_notional = (_new_state->>'size_notional')::numeric,
         margin = (_new_state->>'margin')::numeric,
         entry_fee = (_new_state->>'entry_fee')::numeric,
         rung_count = v_new_filled,
         filled_rung_count = v_new_filled,
         tp_level = NULLIF(_new_state->>'tp_level','')::numeric,
         fills = COALESCE(_new_state->'fills', '[]'::jsonb),
         resize_levels = COALESCE(_new_state->'resize_levels', '[]'::jsonb),
         pending_rungs = COALESCE(_new_state->'pending_rungs', '[]'::jsonb),
         last_seen_candle_ts_ms = NULLIF(_new_state->>'last_seen_candle_ts_ms','')::bigint,
         stop_level = CASE
           WHEN v_should_arm AND v_armed_stop IS NOT NULL THEN v_armed_stop
           ELSE stop_level
         END,
         hard_stop_armed_at = CASE
           WHEN v_should_arm THEN COALESCE(hard_stop_armed_at, v_armed_at, now())
           ELSE hard_stop_armed_at
         END,
         final_rung_fill_price = CASE
           WHEN v_should_arm THEN COALESCE(final_rung_fill_price, v_final_px)
           ELSE final_rung_fill_price
         END,
         armed_stop_price = CASE
           WHEN v_should_arm THEN COALESCE(armed_stop_price, v_armed_stop)
           ELSE armed_stop_price
         END,
         ladder_contract_version = COALESCE(v_contract_ver, ladder_contract_version),
         armed_reason = CASE
           WHEN v_should_arm THEN COALESCE(armed_reason, v_armed_reason)
           ELSE armed_reason
         END
   WHERE id = _position_id AND user_id = _user_id;

  RETURN jsonb_build_object(
    'position_id', _position_id,
    'rung_count', v_new_filled,
    'filled_rung_count', v_new_filled,
    'configured_rung_count', v_configured,
    'armed', v_should_arm
  );
END;
$function$;

-- ── RPC: paper_open_position — persist configured + record rung 1 ─────

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
    ladder_total_margin, ladder_total_notional, ladder_total_rungs,
    configured_rung_count, filled_rung_count
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
    COALESCE((_payload->>'rung_count')::int, 1)
  RETURNING id INTO v_pos_id;

  UPDATE public.paper_wallets
     SET open_position_id = v_pos_id,
         last_tick_at = now()
   WHERE id = _wallet_id AND user_id = _user_id;

  -- Record rung 1 identity in the authoritative table. Idempotent under
  -- retry via the (position_id, rung_index) unique key.
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

  RETURN jsonb_build_object('position_id', v_pos_id);
END;
$function$;
