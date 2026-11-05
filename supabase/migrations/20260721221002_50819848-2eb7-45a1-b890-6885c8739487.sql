
CREATE TABLE IF NOT EXISTS public.paper_authorizations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL,
  connection_id         uuid,
  exchange              text NOT NULL,
  environment           scout_environment NOT NULL,
  market_type           scout_market_type NOT NULL,
  run_id                text NOT NULL,
  epoch_id              uuid REFERENCES public.paper_epochs(id) ON DELETE SET NULL,
  scan_id               uuid NOT NULL,
  signal_id             uuid,
  ranking_snapshot_id   uuid NOT NULL,
  onyx_decision_id      uuid NOT NULL REFERENCES public.onyx_decisions(id) ON DELETE CASCADE,
  symbol                text NOT NULL,
  direction             text NOT NULL CHECK (direction IN ('long','short')),
  formation             text NOT NULL,
  approved_leverage     numeric NOT NULL CHECK (approved_leverage > 0),
  approved_margin_mode  text NOT NULL CHECK (approved_margin_mode IN ('cross','isolated')),
  approved_notional     numeric NOT NULL CHECK (approved_notional > 0),
  approved_margin       numeric NOT NULL CHECK (approved_margin > 0),
  universe_version      integer NOT NULL,
  ranking_version       integer NOT NULL,
  envelope_version      integer,
  rules_version         integer,
  correlation_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  detail                jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at            timestamptz NOT NULL,
  issued_at             timestamptz NOT NULL DEFAULT now(),
  consumed_at           timestamptz,
  consumed_slot_id      uuid,
  consumed_position_id  uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT paper_authorizations_expiry_future CHECK (expires_at > issued_at),
  CONSTRAINT paper_authorizations_decision_unique UNIQUE (onyx_decision_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS paper_authorizations_consumed_slot_uniq
  ON public.paper_authorizations (consumed_slot_id) WHERE consumed_slot_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paper_authorizations_consumed_position_uniq
  ON public.paper_authorizations (consumed_position_id) WHERE consumed_position_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS paper_authorizations_open_idx
  ON public.paper_authorizations (user_id, exchange, environment, market_type, run_id)
  WHERE consumed_at IS NULL;

GRANT SELECT ON public.paper_authorizations TO authenticated;
GRANT ALL ON public.paper_authorizations TO service_role;
ALTER TABLE public.paper_authorizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth: users read own paper_authorizations"
  ON public.paper_authorizations FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "auth: service role full paper_authorizations"
  ON public.paper_authorizations FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public._paper_authorizations_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path TO public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
CREATE TRIGGER paper_authorizations_touch
  BEFORE UPDATE ON public.paper_authorizations
  FOR EACH ROW EXECUTE FUNCTION public._paper_authorizations_touch();

ALTER TABLE public.paper_execution_slots
  ADD COLUMN IF NOT EXISTS authorization_id uuid
    REFERENCES public.paper_authorizations(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paper_execution_slots_auth_uniq
  ON public.paper_execution_slots (authorization_id) WHERE authorization_id IS NOT NULL;

ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS authorization_id uuid
    REFERENCES public.paper_authorizations(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paper_positions_auth_uniq
  ON public.paper_positions (authorization_id) WHERE authorization_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.paper_authorize_and_reserve(
  _user_id uuid, _authorization_id uuid, _ttl_secs integer DEFAULT 300
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public
AS $fn$
DECLARE
  v_auth   public.paper_authorizations%ROWTYPE;
  v_slot_id uuid;
  v_decision record;
BEGIN
  PERFORM public._paper_assert_owner(_user_id);
  IF _authorization_id IS NULL THEN
    RAISE EXCEPTION 'authorization_id required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_auth FROM public.paper_authorizations
    WHERE id = _authorization_id AND user_id = _user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'paper_authorize_and_reserve: authorization % not found for user %',
      _authorization_id, _user_id USING ERRCODE = '42501';
  END IF;
  IF v_auth.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'paper_authorize_and_reserve: authorization % already consumed at %',
      _authorization_id, v_auth.consumed_at USING ERRCODE = 'check_violation';
  END IF;
  IF v_auth.expires_at <= now() THEN
    RAISE EXCEPTION 'paper_authorize_and_reserve: authorization % expired at %',
      _authorization_id, v_auth.expires_at USING ERRCODE = 'check_violation';
  END IF;

  SELECT user_id, symbol, side, decision, scan_id INTO v_decision
    FROM public.onyx_decisions WHERE id = v_auth.onyx_decision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'paper_authorize_and_reserve: onyx_decision % missing',
      v_auth.onyx_decision_id USING ERRCODE = 'check_violation';
  END IF;
  IF v_decision.user_id <> _user_id
     OR v_decision.symbol <> v_auth.symbol
     OR v_decision.side <> v_auth.direction
     OR v_decision.decision NOT IN ('approve','approved','open')
     OR v_decision.scan_id IS DISTINCT FROM v_auth.scan_id THEN
    RAISE EXCEPTION 'paper_authorize_and_reserve: onyx_decision % does not match authorization scope',
      v_auth.onyx_decision_id USING ERRCODE = 'check_violation';
  END IF;

  WITH candidate AS (
    SELECT id FROM public.paper_execution_slots
     WHERE user_id     = _user_id
       AND exchange    = v_auth.exchange
       AND environment = v_auth.environment
       AND market_type = v_auth.market_type
       AND (v_auth.connection_id IS NULL OR connection_id IS NOT DISTINCT FROM v_auth.connection_id)
       AND state       = 'unassigned'
     ORDER BY slot_index FOR UPDATE SKIP LOCKED LIMIT 1
  )
  UPDATE public.paper_execution_slots s
     SET state='reserved',
         assigned_symbol=v_auth.symbol,
         assigned_direction=v_auth.direction,
         authorization_id=v_auth.id,
         correlation_id=v_auth.correlation_id,
         reservation_expires_at=now() + make_interval(secs => GREATEST(_ttl_secs, 10)),
         last_transition_at=now(),
         capacity_version=s.capacity_version + 1,
         updated_at=now()
    FROM candidate c WHERE s.id = c.id
  RETURNING s.id INTO v_slot_id;

  IF v_slot_id IS NULL THEN
    RETURN jsonb_build_object('slot_id', NULL, 'authorization_id', v_auth.id, 'reason', 'no_free_slot');
  END IF;

  UPDATE public.paper_authorizations
     SET consumed_at=now(), consumed_slot_id=v_slot_id, updated_at=now()
   WHERE id = v_auth.id;

  RETURN jsonb_build_object(
    'slot_id', v_slot_id,
    'authorization_id', v_auth.id,
    'correlation_id', v_auth.correlation_id,
    'symbol', v_auth.symbol,
    'direction', v_auth.direction,
    'exchange', v_auth.exchange,
    'environment', v_auth.environment,
    'market_type', v_auth.market_type,
    'run_id', v_auth.run_id
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.paper_authorize_and_reserve(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.paper_authorize_and_reserve(uuid, uuid, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.paper_release_execution_slot(
  _user_id uuid, _slot_id uuid, _reason text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public
AS $fn$
DECLARE v_released boolean := false; v_auth_id uuid;
BEGIN
  PERFORM public._paper_assert_owner(_user_id);
  IF _slot_id IS NULL THEN RETURN false; END IF;
  SELECT authorization_id INTO v_auth_id FROM public.paper_execution_slots
    WHERE id = _slot_id AND user_id = _user_id FOR UPDATE;
  UPDATE public.paper_execution_slots
     SET state='unassigned', assigned_symbol=NULL, assigned_direction=NULL,
         correlation_id=NULL, reservation_expires_at=NULL, position_id=NULL,
         authorization_id=NULL, last_transition_at=now(),
         capacity_version=capacity_version + 1,
         detail=COALESCE(detail,'{}'::jsonb) || jsonb_build_object(
                'last_release_reason', COALESCE(_reason,'unspecified'),
                'last_release_at', to_jsonb(now()),
                'last_release_authorization_id', to_jsonb(v_auth_id)),
         updated_at=now()
   WHERE id = _slot_id AND user_id = _user_id AND state = 'reserved';
  GET DIAGNOSTICS v_released = ROW_COUNT;
  RETURN v_released;
END;
$fn$;

REVOKE ALL ON FUNCTION public.paper_release_execution_slot(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.paper_release_execution_slot(uuid, uuid, text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.paper_assign_execution_slot(uuid, text, text, uuid, integer) FROM authenticated;

CREATE OR REPLACE FUNCTION public.paper_open_position(_user_id uuid, _wallet_id uuid, _payload jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_pos_id uuid;
  v_is_ladder boolean := COALESCE((_payload->>'ladder_strategy')::boolean, false);
  v_stop_level numeric := CASE WHEN v_is_ladder THEN NULL ELSE (_payload->>'stop_level')::numeric END;
  v_configured int := NULLIF(_payload->>'ladder_total_rungs','')::int;
  v_initial_fills jsonb := COALESCE(_payload->'fills', '[]'::jsonb);
  v_first_fill jsonb;
  v_slot_id uuid := NULLIF(_payload->>'slot_id','')::uuid;
  v_auth_id uuid := NULLIF(_payload->>'authorization_id','')::uuid;
  v_slot_state paper_slot_state;
  v_slot_symbol text;
  v_slot_direction text;
  v_slot_auth uuid;
  v_authority_mode text;
BEGIN
  PERFORM public._paper_assert_owner(_user_id);
  IF _wallet_id IS NULL OR _payload IS NULL THEN
    RAISE EXCEPTION 'wallet_id, payload required';
  END IF;

  PERFORM 1 FROM public.paper_wallets
    WHERE id = _wallet_id AND user_id = _user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'wallet not found' USING ERRCODE = '42501';
  END IF;

  SELECT mode INTO v_authority_mode FROM public.paper_engine_authority WHERE user_id = _user_id;

  IF v_slot_id IS NOT NULL THEN
    SELECT state, assigned_symbol, assigned_direction, authorization_id
      INTO v_slot_state, v_slot_symbol, v_slot_direction, v_slot_auth
      FROM public.paper_execution_slots
     WHERE id = v_slot_id AND user_id = _user_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'paper_open_position: slot % not found for user %',
        v_slot_id, _user_id USING ERRCODE = '42501';
    END IF;
    IF v_slot_state <> 'reserved' THEN
      RAISE EXCEPTION 'paper_open_position: slot % in state % (expected reserved)',
        v_slot_id, v_slot_state USING ERRCODE = 'check_violation';
    END IF;
    IF v_slot_symbol IS DISTINCT FROM (_payload->>'symbol')
       OR v_slot_direction IS DISTINCT FROM (_payload->>'direction') THEN
      RAISE EXCEPTION 'paper_open_position: slot % assigned %/% mismatches payload %/%',
        v_slot_id, v_slot_symbol, v_slot_direction, _payload->>'symbol', _payload->>'direction'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_auth_id IS NOT NULL AND v_slot_auth IS DISTINCT FROM v_auth_id THEN
      RAISE EXCEPTION 'paper_open_position: authorization % does not match slot authorization %',
        v_auth_id, v_slot_auth USING ERRCODE = 'check_violation';
    END IF;
    IF v_auth_id IS NULL THEN v_auth_id := v_slot_auth; END IF;
  END IF;

  IF v_authority_mode = 'dynamic_universe' AND v_auth_id IS NULL THEN
    RAISE EXCEPTION 'paper_authority_violation: dynamic_universe user % requires authorization_id',
      _user_id USING ERRCODE = 'check_violation';
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
    slot_id, authorization_id
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
    v_slot_id,
    v_auth_id
  RETURNING id INTO v_pos_id;

  UPDATE public.paper_wallets
     SET open_position_id = v_pos_id, last_tick_at = now()
   WHERE id = _wallet_id AND user_id = _user_id;

  IF v_slot_id IS NOT NULL THEN
    UPDATE public.paper_execution_slots
       SET state='active', position_id=v_pos_id, reservation_expires_at=NULL,
           last_transition_at=now(), capacity_version=capacity_version + 1,
           updated_at=now()
     WHERE id = v_slot_id AND user_id = _user_id;
  END IF;

  IF v_auth_id IS NOT NULL THEN
    UPDATE public.paper_authorizations
       SET consumed_position_id = v_pos_id, updated_at = now()
     WHERE id = v_auth_id AND user_id = _user_id;
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
    'slot_id', v_slot_id,
    'authorization_id', v_auth_id
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.paper_open_position(uuid, uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.paper_open_position(uuid, uuid, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._paper_positions_authority_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_mode text; v_slot record;
BEGIN
  SELECT mode INTO v_mode FROM public.paper_engine_authority WHERE user_id = NEW.user_id;
  IF v_mode IS DISTINCT FROM 'dynamic_universe' THEN RETURN NEW; END IF;

  IF NEW.slot_id IS NULL THEN
    RAISE EXCEPTION 'paper_authority_violation: dynamic_universe user % insert with NULL slot_id (%, %)',
      NEW.user_id, NEW.symbol, NEW.direction USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.authorization_id IS NULL THEN
    RAISE EXCEPTION 'paper_authority_violation: dynamic_universe user % insert with NULL authorization_id (%, %)',
      NEW.user_id, NEW.symbol, NEW.direction USING ERRCODE = 'check_violation';
  END IF;

  SELECT id, user_id, state, assigned_symbol, assigned_direction, position_id, authorization_id
    INTO v_slot FROM public.paper_execution_slots
    WHERE id = NEW.slot_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'paper_authority_violation: slot % not found', NEW.slot_id USING ERRCODE='check_violation';
  END IF;
  IF v_slot.user_id <> NEW.user_id THEN
    RAISE EXCEPTION 'paper_authority_violation: slot % owned by %, not %',
      NEW.slot_id, v_slot.user_id, NEW.user_id USING ERRCODE='check_violation';
  END IF;
  IF v_slot.state NOT IN ('reserved','committed','active') THEN
    RAISE EXCEPTION 'paper_authority_violation: slot % state % not open for entry',
      NEW.slot_id, v_slot.state USING ERRCODE='check_violation';
  END IF;
  IF v_slot.assigned_symbol IS DISTINCT FROM NEW.symbol
     OR v_slot.assigned_direction IS DISTINCT FROM NEW.direction THEN
    RAISE EXCEPTION 'paper_authority_violation: slot %/% != insert %/%',
      v_slot.assigned_symbol, v_slot.assigned_direction, NEW.symbol, NEW.direction
      USING ERRCODE='check_violation';
  END IF;
  IF v_slot.authorization_id IS DISTINCT FROM NEW.authorization_id THEN
    RAISE EXCEPTION 'paper_authority_violation: slot auth % != insert auth %',
      v_slot.authorization_id, NEW.authorization_id USING ERRCODE='check_violation';
  END IF;
  IF v_slot.position_id IS NOT NULL AND v_slot.position_id <> NEW.id THEN
    RAISE EXCEPTION 'paper_authority_violation: slot % already linked to %',
      NEW.slot_id, v_slot.position_id USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
