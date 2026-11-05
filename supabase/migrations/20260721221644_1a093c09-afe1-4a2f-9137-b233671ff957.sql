
-- ── paper_symbol_pods ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.paper_symbol_pods (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL,
  connection_id      uuid,
  exchange           text NOT NULL,
  environment        scout_environment NOT NULL,
  market_type        scout_market_type NOT NULL,
  run_id             text NOT NULL,
  pod_index          integer NOT NULL CHECK (pod_index BETWEEN 1 AND 10),
  state              text NOT NULL DEFAULT 'empty'
                     CHECK (state IN ('empty','bound','retired')),
  assigned_symbol    text,
  bound_at           timestamptz,
  bound_authorization_id uuid,
  risk_budget_notional numeric,
  risk_budget_margin   numeric,
  ranking_snapshot_id  uuid,
  capacity_version   integer NOT NULL DEFAULT 0,
  detail             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT paper_symbol_pods_state_symbol CHECK (
    (state = 'empty'   AND assigned_symbol IS NULL) OR
    (state = 'bound'   AND assigned_symbol IS NOT NULL) OR
    (state = 'retired')
  ),
  CONSTRAINT paper_symbol_pods_scope_index_uniq UNIQUE
    (user_id, exchange, environment, market_type, run_id, pod_index)
);

-- A symbol can only be bound to one active pod in scope.
CREATE UNIQUE INDEX IF NOT EXISTS paper_symbol_pods_scope_symbol_uniq
  ON public.paper_symbol_pods (user_id, exchange, environment, market_type, run_id, assigned_symbol)
  WHERE state = 'bound' AND assigned_symbol IS NOT NULL;

CREATE INDEX IF NOT EXISTS paper_symbol_pods_scope_state_idx
  ON public.paper_symbol_pods (user_id, exchange, environment, market_type, run_id, state);

GRANT SELECT ON public.paper_symbol_pods TO authenticated;
GRANT ALL ON public.paper_symbol_pods TO service_role;
ALTER TABLE public.paper_symbol_pods ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pods: users read own"
  ON public.paper_symbol_pods FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "pods: service role full"
  ON public.paper_symbol_pods FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public._paper_symbol_pods_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path TO public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
CREATE TRIGGER paper_symbol_pods_touch
  BEFORE UPDATE ON public.paper_symbol_pods
  FOR EACH ROW EXECUTE FUNCTION public._paper_symbol_pods_touch();

-- ── paper_wallet_legs ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.paper_wallet_legs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id                 uuid NOT NULL REFERENCES public.paper_symbol_pods(id) ON DELETE CASCADE,
  user_id                uuid NOT NULL,
  leg_direction          text NOT NULL CHECK (leg_direction IN ('long','short')),
  state                  text NOT NULL DEFAULT 'idle'
                         CHECK (state IN ('idle','ready','reserved','active','closing')),
  purpose                text CHECK (purpose IN ('primary','hedge','opposing_opportunity')),
  assigned_symbol        text,
  authorization_id       uuid,
  position_id            uuid,
  correlation_id         uuid,
  reservation_expires_at timestamptz,
  wallet_key             text,
  balance                numeric,
  detail                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_transition_at     timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT paper_wallet_legs_pod_direction_uniq UNIQUE (pod_id, leg_direction)
);

CREATE INDEX IF NOT EXISTS paper_wallet_legs_user_state_idx
  ON public.paper_wallet_legs (user_id, state);
CREATE UNIQUE INDEX IF NOT EXISTS paper_wallet_legs_authorization_uniq
  ON public.paper_wallet_legs (authorization_id)
  WHERE authorization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paper_wallet_legs_position_uniq
  ON public.paper_wallet_legs (position_id)
  WHERE position_id IS NOT NULL;

GRANT SELECT ON public.paper_wallet_legs TO authenticated;
GRANT ALL ON public.paper_wallet_legs TO service_role;
ALTER TABLE public.paper_wallet_legs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "legs: users read own"
  ON public.paper_wallet_legs FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "legs: service role full"
  ON public.paper_wallet_legs FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public._paper_wallet_legs_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path TO public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;
CREATE TRIGGER paper_wallet_legs_touch
  BEFORE UPDATE ON public.paper_wallet_legs
  FOR EACH ROW EXECUTE FUNCTION public._paper_wallet_legs_touch();

-- Ensure exactly one long + one short leg per pod (invariant test).
CREATE OR REPLACE FUNCTION public.paper_pod_has_valid_leg_pair(_pod_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public AS $$
  SELECT COUNT(*) FILTER (WHERE leg_direction = 'long')  = 1
     AND COUNT(*) FILTER (WHERE leg_direction = 'short') = 1
     AND COUNT(*) = 2
  FROM public.paper_wallet_legs WHERE pod_id = _pod_id;
$$;

-- ── link pod/leg onto authorizations, positions, slots ───────────────
ALTER TABLE public.paper_authorizations
  ADD COLUMN IF NOT EXISTS pod_id uuid REFERENCES public.paper_symbol_pods(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS leg_id uuid REFERENCES public.paper_wallet_legs(id)  ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS purpose text CHECK (purpose IN ('primary','hedge','opposing_opportunity'));

ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS pod_id uuid REFERENCES public.paper_symbol_pods(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS leg_id uuid REFERENCES public.paper_wallet_legs(id)  ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS paper_positions_leg_uniq
  ON public.paper_positions (leg_id) WHERE leg_id IS NOT NULL AND status = 'open';

-- Legacy slots table keeps history but is no longer authority. Retire the
-- global "hedge_reserved" / "recovery_reserved" slot semantics by moving
-- any residual rows back to 'unassigned' — new authority is pods/legs.
UPDATE public.paper_execution_slots
   SET state = 'unassigned',
       assigned_symbol = NULL,
       assigned_direction = NULL,
       reservation_expires_at = NULL,
       correlation_id = NULL,
       detail = COALESCE(detail,'{}'::jsonb)
              || jsonb_build_object('retired_state_at', to_jsonb(now()),
                                    'retired_reason', 'global_hedge_recovery_model_removed')
 WHERE state IN ('hedge_reserved','recovery_reserved');

-- ── RPC: seed pods+legs idempotently for a scope ─────────────────────
CREATE OR REPLACE FUNCTION public.paper_ensure_symbol_pods(
  _user_id       uuid,
  _connection_id uuid,
  _exchange      text,
  _environment   scout_environment,
  _market_type   scout_market_type,
  _run_id        text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public
AS $fn$
DECLARE i integer; v_pod uuid; v_created integer := 0; v_legs integer := 0;
BEGIN
  PERFORM public._paper_assert_owner(_user_id);
  IF _exchange IS NULL OR _run_id IS NULL THEN
    RAISE EXCEPTION 'exchange and run_id required' USING ERRCODE='22023';
  END IF;

  FOR i IN 1..10 LOOP
    SELECT id INTO v_pod
      FROM public.paper_symbol_pods
     WHERE user_id=_user_id AND exchange=_exchange
       AND environment=_environment AND market_type=_market_type
       AND run_id=_run_id AND pod_index=i;
    IF v_pod IS NULL THEN
      INSERT INTO public.paper_symbol_pods
        (user_id, connection_id, exchange, environment, market_type, run_id, pod_index)
        VALUES (_user_id, _connection_id, _exchange, _environment, _market_type, _run_id, i)
      RETURNING id INTO v_pod;
      v_created := v_created + 1;
    END IF;

    INSERT INTO public.paper_wallet_legs (pod_id, user_id, leg_direction, state)
      VALUES (v_pod, _user_id, 'long',  'idle')
    ON CONFLICT (pod_id, leg_direction) DO NOTHING;
    IF FOUND THEN v_legs := v_legs + 1; END IF;

    INSERT INTO public.paper_wallet_legs (pod_id, user_id, leg_direction, state)
      VALUES (v_pod, _user_id, 'short', 'idle')
    ON CONFLICT (pod_id, leg_direction) DO NOTHING;
    IF FOUND THEN v_legs := v_legs + 1; END IF;
  END LOOP;

  RETURN jsonb_build_object('pods_created', v_created, 'legs_created', v_legs);
END;
$fn$;
REVOKE ALL ON FUNCTION public.paper_ensure_symbol_pods(uuid,uuid,text,scout_environment,scout_market_type,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.paper_ensure_symbol_pods(uuid,uuid,text,scout_environment,scout_market_type,text) TO authenticated, service_role;

-- ── RPC: atomic pod bind + leg reservation from an authorization ─────
CREATE OR REPLACE FUNCTION public.paper_bind_pod_and_reserve_leg(
  _user_id          uuid,
  _authorization_id uuid,
  _purpose          text DEFAULT 'primary',
  _ttl_secs         integer DEFAULT 300
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public
AS $fn$
DECLARE
  v_auth public.paper_authorizations%ROWTYPE;
  v_pod_id uuid;
  v_leg_id uuid;
  v_leg_state text;
  v_pod_state text;
  v_decision record;
BEGIN
  PERFORM public._paper_assert_owner(_user_id);
  IF _authorization_id IS NULL THEN
    RAISE EXCEPTION 'authorization_id required' USING ERRCODE='22023';
  END IF;
  IF _purpose NOT IN ('primary','hedge','opposing_opportunity') THEN
    RAISE EXCEPTION 'invalid purpose %', _purpose USING ERRCODE='22023';
  END IF;

  SELECT * INTO v_auth FROM public.paper_authorizations
    WHERE id=_authorization_id AND user_id=_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'authorization % not found', _authorization_id USING ERRCODE='42501';
  END IF;
  IF v_auth.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'authorization % already consumed', _authorization_id USING ERRCODE='check_violation';
  END IF;
  IF v_auth.expires_at <= now() THEN
    RAISE EXCEPTION 'authorization % expired', _authorization_id USING ERRCODE='check_violation';
  END IF;

  SELECT user_id, symbol, side, decision, scan_id INTO v_decision
    FROM public.onyx_decisions WHERE id = v_auth.onyx_decision_id;
  IF NOT FOUND
     OR v_decision.user_id <> _user_id
     OR v_decision.symbol <> v_auth.symbol
     OR v_decision.side <> v_auth.direction
     OR v_decision.decision NOT IN ('approve','approved','open')
     OR v_decision.scan_id IS DISTINCT FROM v_auth.scan_id THEN
    RAISE EXCEPTION 'onyx_decision % does not match authorization scope', v_auth.onyx_decision_id
      USING ERRCODE='check_violation';
  END IF;

  -- 1. Reject if symbol is already bound to a different pod in scope.
  SELECT id, state INTO v_pod_id, v_pod_state
    FROM public.paper_symbol_pods
    WHERE user_id=_user_id AND exchange=v_auth.exchange
      AND environment=v_auth.environment AND market_type=v_auth.market_type
      AND run_id=v_auth.run_id
      AND assigned_symbol = v_auth.symbol AND state = 'bound'
    FOR UPDATE;

  -- 2. If no existing bound pod, claim the lowest-index empty pod.
  IF v_pod_id IS NULL THEN
    WITH candidate AS (
      SELECT id FROM public.paper_symbol_pods
       WHERE user_id=_user_id AND exchange=v_auth.exchange
         AND environment=v_auth.environment AND market_type=v_auth.market_type
         AND run_id=v_auth.run_id AND state='empty'
       ORDER BY pod_index
       FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE public.paper_symbol_pods p
       SET state='bound',
           assigned_symbol=v_auth.symbol,
           bound_at=now(),
           bound_authorization_id=v_auth.id,
           risk_budget_notional=v_auth.approved_notional,
           risk_budget_margin=v_auth.approved_margin,
           ranking_snapshot_id=v_auth.ranking_snapshot_id,
           capacity_version=p.capacity_version+1
      FROM candidate c WHERE p.id=c.id
    RETURNING p.id INTO v_pod_id;

    IF v_pod_id IS NULL THEN
      RETURN jsonb_build_object('pod_id',NULL,'leg_id',NULL,'reason','no_free_pod');
    END IF;
  ELSIF _purpose = 'primary' THEN
    -- Primary re-entry on same pod is fine as long as its directional leg is idle/ready.
    NULL;
  END IF;

  -- 3. Reserve the direction-locked leg on that pod.
  SELECT id, state INTO v_leg_id, v_leg_state
    FROM public.paper_wallet_legs
    WHERE pod_id = v_pod_id AND leg_direction = v_auth.direction
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pod % missing % leg', v_pod_id, v_auth.direction USING ERRCODE='check_violation';
  END IF;
  IF v_leg_state NOT IN ('idle','ready') THEN
    RAISE EXCEPTION 'leg % on pod % is %; cannot reserve for %',
      v_auth.direction, v_pod_id, v_leg_state, _purpose USING ERRCODE='check_violation';
  END IF;

  UPDATE public.paper_wallet_legs
     SET state='reserved',
         purpose=_purpose,
         assigned_symbol=v_auth.symbol,
         authorization_id=v_auth.id,
         correlation_id=v_auth.correlation_id,
         reservation_expires_at=now() + make_interval(secs => GREATEST(_ttl_secs,10)),
         last_transition_at=now()
   WHERE id = v_leg_id;

  UPDATE public.paper_authorizations
     SET consumed_at=now(),
         pod_id=v_pod_id,
         leg_id=v_leg_id,
         purpose=_purpose,
         updated_at=now()
   WHERE id = v_auth.id;

  RETURN jsonb_build_object(
    'pod_id', v_pod_id,
    'leg_id', v_leg_id,
    'authorization_id', v_auth.id,
    'symbol', v_auth.symbol,
    'direction', v_auth.direction,
    'purpose', _purpose
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.paper_bind_pod_and_reserve_leg(uuid,uuid,text,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.paper_bind_pod_and_reserve_leg(uuid,uuid,text,integer) TO authenticated, service_role;

-- ── Release a reserved leg without unbinding pod symbol ─────────────
CREATE OR REPLACE FUNCTION public.paper_release_wallet_leg(
  _user_id uuid, _leg_id uuid, _reason text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public
AS $fn$
DECLARE v_released boolean := false;
BEGIN
  PERFORM public._paper_assert_owner(_user_id);
  UPDATE public.paper_wallet_legs
     SET state='ready',
         purpose=NULL,
         authorization_id=NULL,
         correlation_id=NULL,
         reservation_expires_at=NULL,
         position_id=NULL,
         last_transition_at=now(),
         detail=COALESCE(detail,'{}'::jsonb) || jsonb_build_object(
           'last_release_reason', COALESCE(_reason,'unspecified'),
           'last_release_at', to_jsonb(now()))
   WHERE id=_leg_id AND user_id=_user_id AND state IN ('reserved','ready','active','closing');
  GET DIAGNOSTICS v_released = ROW_COUNT;
  RETURN v_released;
END;
$fn$;
REVOKE ALL ON FUNCTION public.paper_release_wallet_leg(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.paper_release_wallet_leg(uuid,uuid,text) TO authenticated, service_role;

-- ── paper_open_position: promote leg to active when leg_id provided ─
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
  v_pod_id  uuid := NULLIF(_payload->>'pod_id','')::uuid;
  v_leg_id  uuid := NULLIF(_payload->>'leg_id','')::uuid;
  v_leg_state text; v_leg_dir text; v_leg_symbol text; v_leg_auth uuid; v_leg_pod uuid;
  v_authority_mode text;
BEGIN
  PERFORM public._paper_assert_owner(_user_id);
  IF _wallet_id IS NULL OR _payload IS NULL THEN
    RAISE EXCEPTION 'wallet_id, payload required';
  END IF;
  PERFORM 1 FROM public.paper_wallets WHERE id=_wallet_id AND user_id=_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'wallet not found' USING ERRCODE='42501'; END IF;

  SELECT mode INTO v_authority_mode FROM public.paper_engine_authority WHERE user_id=_user_id;

  IF v_leg_id IS NOT NULL THEN
    SELECT state, leg_direction, assigned_symbol, authorization_id, pod_id
      INTO v_leg_state, v_leg_dir, v_leg_symbol, v_leg_auth, v_leg_pod
      FROM public.paper_wallet_legs
     WHERE id=v_leg_id AND user_id=_user_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'paper_open_position: leg % not found', v_leg_id USING ERRCODE='42501';
    END IF;
    IF v_leg_state <> 'reserved' THEN
      RAISE EXCEPTION 'paper_open_position: leg % state % (expected reserved)', v_leg_id, v_leg_state
        USING ERRCODE='check_violation';
    END IF;
    IF v_leg_dir IS DISTINCT FROM (_payload->>'direction')
       OR v_leg_symbol IS DISTINCT FROM (_payload->>'symbol') THEN
      RAISE EXCEPTION 'paper_open_position: leg %/% mismatches payload %/%',
        v_leg_symbol, v_leg_dir, _payload->>'symbol', _payload->>'direction'
        USING ERRCODE='check_violation';
    END IF;
    IF v_auth_id IS NOT NULL AND v_leg_auth IS DISTINCT FROM v_auth_id THEN
      RAISE EXCEPTION 'paper_open_position: auth mismatch on leg' USING ERRCODE='check_violation';
    END IF;
    IF v_auth_id IS NULL THEN v_auth_id := v_leg_auth; END IF;
    IF v_pod_id IS NULL THEN v_pod_id := v_leg_pod; END IF;
  END IF;

  IF v_authority_mode = 'dynamic_universe' THEN
    IF v_auth_id IS NULL THEN
      RAISE EXCEPTION 'paper_authority_violation: dynamic_universe requires authorization_id'
        USING ERRCODE='check_violation';
    END IF;
    IF v_leg_id IS NULL THEN
      RAISE EXCEPTION 'paper_authority_violation: dynamic_universe requires leg_id'
        USING ERRCODE='check_violation';
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
    slot_id, authorization_id, pod_id, leg_id
  ) SELECT
    _user_id, _payload->>'wallet_key', _payload->>'symbol', _payload->>'direction', 'open',
    (_payload->>'entry_price')::numeric, (_payload->>'entry_ts')::timestamptz,
    (_payload->>'entry_candle_ts_ms')::bigint,
    NULLIF(_payload->>'tp_level','')::numeric, v_stop_level,
    (_payload->>'zone_lower')::numeric, (_payload->>'zone_upper')::numeric, (_payload->>'zone_level')::numeric,
    (_payload->>'size_qty')::numeric, (_payload->>'size_notional')::numeric,
    (_payload->>'margin')::numeric, (_payload->>'leverage')::numeric, (_payload->>'entry_fee')::numeric,
    NULLIF(_payload->>'opened_from_signal',''),
    (_payload->>'last_seen_candle_ts_ms')::bigint,
    NULLIF(_payload->>'trend_at_entry',''),
    NULLIF(_payload->>'trend_slope_pct_at_entry','')::numeric,
    COALESCE(_payload->>'strategy','accumulator'),
    NULLIF(_payload->>'regime_at_entry',''),
    NULLIF(_payload->>'onyx_rationale',''),
    COALESCE((_payload->>'rung_count')::int,1),
    NULLIF(_payload->>'first_fill_vwap','')::numeric,
    v_initial_fills, COALESCE(_payload->'resize_levels','[]'::jsonb),
    COALESCE(_payload->'pending_rungs','[]'::jsonb),
    NULLIF(_payload->>'ladder_total_margin','')::numeric,
    NULLIF(_payload->>'ladder_total_notional','')::numeric,
    v_configured, v_configured,
    COALESCE((_payload->>'rung_count')::int,1),
    v_slot_id, v_auth_id, v_pod_id, v_leg_id
  RETURNING id INTO v_pos_id;

  UPDATE public.paper_wallets
     SET open_position_id=v_pos_id, last_tick_at=now()
   WHERE id=_wallet_id AND user_id=_user_id;

  IF v_leg_id IS NOT NULL THEN
    UPDATE public.paper_wallet_legs
       SET state='active', position_id=v_pos_id, reservation_expires_at=NULL,
           last_transition_at=now()
     WHERE id=v_leg_id AND user_id=_user_id;
  END IF;
  IF v_slot_id IS NOT NULL THEN
    UPDATE public.paper_execution_slots
       SET state='active', position_id=v_pos_id, reservation_expires_at=NULL,
           last_transition_at=now(), capacity_version=capacity_version+1
     WHERE id=v_slot_id AND user_id=_user_id;
  END IF;
  IF v_auth_id IS NOT NULL THEN
    UPDATE public.paper_authorizations
       SET consumed_position_id=v_pos_id, updated_at=now()
     WHERE id=v_auth_id AND user_id=_user_id;
  END IF;

  IF jsonb_array_length(v_initial_fills) > 0 THEN
    v_first_fill := v_initial_fills->0;
    IF (v_first_fill->>'price') IS NOT NULL THEN
      INSERT INTO public.paper_rung_fills (
        user_id, position_id, rung_index, fill_price, qty, margin, tp_price,
        fill_status, filled_at, candle_ts_ms
      ) VALUES (
        _user_id, v_pos_id, 1,
        (v_first_fill->>'price')::numeric,
        COALESCE((v_first_fill->>'qty')::numeric,0),
        COALESCE((v_first_fill->>'margin')::numeric,0),
        COALESCE((v_first_fill->>'tp')::numeric,0),
        'filled', (_payload->>'entry_ts')::timestamptz,
        (_payload->>'entry_candle_ts_ms')::bigint
      ) ON CONFLICT (position_id, rung_index) DO NOTHING;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'position_id', v_pos_id, 'slot_id', v_slot_id,
    'authorization_id', v_auth_id, 'pod_id', v_pod_id, 'leg_id', v_leg_id
  );
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.paper_open_position(uuid, uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.paper_open_position(uuid, uuid, jsonb) TO authenticated, service_role;

-- ── Authority trigger: dynamic_universe requires leg+auth match ─────
CREATE OR REPLACE FUNCTION public._paper_positions_authority_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_mode text; v_leg record; v_pod record;
BEGIN
  SELECT mode INTO v_mode FROM public.paper_engine_authority WHERE user_id=NEW.user_id;
  IF v_mode IS DISTINCT FROM 'dynamic_universe' THEN RETURN NEW; END IF;

  IF NEW.authorization_id IS NULL THEN
    RAISE EXCEPTION 'paper_authority_violation: dynamic_universe insert requires authorization_id (%, %)',
      NEW.symbol, NEW.direction USING ERRCODE='check_violation';
  END IF;
  IF NEW.leg_id IS NULL THEN
    RAISE EXCEPTION 'paper_authority_violation: dynamic_universe insert requires leg_id (%, %)',
      NEW.symbol, NEW.direction USING ERRCODE='check_violation';
  END IF;

  SELECT id, user_id, pod_id, leg_direction, assigned_symbol, authorization_id, position_id, state
    INTO v_leg FROM public.paper_wallet_legs
    WHERE id = NEW.leg_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'paper_authority_violation: leg % not found', NEW.leg_id USING ERRCODE='check_violation';
  END IF;
  IF v_leg.user_id <> NEW.user_id THEN
    RAISE EXCEPTION 'paper_authority_violation: leg owner mismatch' USING ERRCODE='check_violation';
  END IF;
  IF v_leg.leg_direction IS DISTINCT FROM NEW.direction THEN
    RAISE EXCEPTION 'paper_authority_violation: leg direction % != insert %',
      v_leg.leg_direction, NEW.direction USING ERRCODE='check_violation';
  END IF;
  IF v_leg.assigned_symbol IS DISTINCT FROM NEW.symbol THEN
    RAISE EXCEPTION 'paper_authority_violation: leg symbol % != insert %',
      v_leg.assigned_symbol, NEW.symbol USING ERRCODE='check_violation';
  END IF;
  IF v_leg.authorization_id IS DISTINCT FROM NEW.authorization_id THEN
    RAISE EXCEPTION 'paper_authority_violation: leg auth != insert auth' USING ERRCODE='check_violation';
  END IF;
  IF v_leg.state NOT IN ('reserved','active') THEN
    RAISE EXCEPTION 'paper_authority_violation: leg state % not open for entry', v_leg.state
      USING ERRCODE='check_violation';
  END IF;
  IF v_leg.position_id IS NOT NULL AND v_leg.position_id <> NEW.id THEN
    RAISE EXCEPTION 'paper_authority_violation: leg already linked to position %', v_leg.position_id
      USING ERRCODE='check_violation';
  END IF;

  IF NEW.pod_id IS NOT NULL AND NEW.pod_id <> v_leg.pod_id THEN
    RAISE EXCEPTION 'paper_authority_violation: pod_id % != leg.pod_id %',
      NEW.pod_id, v_leg.pod_id USING ERRCODE='check_violation';
  END IF;

  SELECT id, assigned_symbol, state INTO v_pod
    FROM public.paper_symbol_pods WHERE id = v_leg.pod_id;
  IF NOT FOUND OR v_pod.state <> 'bound' OR v_pod.assigned_symbol IS DISTINCT FROM NEW.symbol THEN
    RAISE EXCEPTION 'paper_authority_violation: pod state/symbol mismatch (%, %)',
      v_pod.state, v_pod.assigned_symbol USING ERRCODE='check_violation';
  END IF;

  RETURN NEW;
END;
$function$;
