
-- ==========================================================
-- PAPER WALLET CATEGORIZATION (add columns; keep existing wallets untouched)
-- ==========================================================
ALTER TABLE public.paper_wallets
  ADD COLUMN IF NOT EXISTS direction_scope text NOT NULL DEFAULT 'any',
  ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'paper',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS balance_source text NOT NULL DEFAULT 'simulated',
  ADD COLUMN IF NOT EXISTS monitor_role text,
  ADD COLUMN IF NOT EXISTS execution_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS activated_by uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_wallets_direction_scope_ck') THEN
    ALTER TABLE public.paper_wallets
      ADD CONSTRAINT paper_wallets_direction_scope_ck
      CHECK (direction_scope IN ('long','short','any'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_wallets_environment_ck') THEN
    ALTER TABLE public.paper_wallets
      ADD CONSTRAINT paper_wallets_environment_ck
      CHECK (environment IN ('paper','mainnet'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_wallets_status_ck') THEN
    ALTER TABLE public.paper_wallets
      ADD CONSTRAINT paper_wallets_status_ck
      CHECK (status IN ('active','monitoring','disabled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_wallets_balance_source_ck') THEN
    ALTER TABLE public.paper_wallets
      ADD CONSTRAINT paper_wallets_balance_source_ck
      CHECK (balance_source IN ('simulated','verified'));
  END IF;
END $$;

-- Hard invariant: monitoring wallets can never live on mainnet.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_wallets_monitor_paper_only_ck') THEN
    ALTER TABLE public.paper_wallets
      ADD CONSTRAINT paper_wallets_monitor_paper_only_ck
      CHECK (status <> 'monitoring' OR (environment = 'paper' AND balance_source = 'simulated'));
  END IF;
END $$;

-- ==========================================================
-- WALLET ACTIVATION AUDIT (append-only)
-- ==========================================================
CREATE TABLE IF NOT EXISTS public.wallet_activation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wallet_id uuid NOT NULL REFERENCES public.paper_wallets(id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN ('created','execution_enabled','execution_disabled','status_changed')),
  from_state jsonb,
  to_state jsonb,
  actor text NOT NULL DEFAULT 'server',
  server_ts timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.wallet_activation_events TO authenticated;
GRANT ALL ON public.wallet_activation_events TO service_role;

ALTER TABLE public.wallet_activation_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own wallet activation events readable"
  ON public.wallet_activation_events FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Block direct mutation from authenticated; only SECURITY DEFINER writers touch it.
CREATE OR REPLACE FUNCTION public.wallet_activation_events_block_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  RAISE EXCEPTION 'wallet_activation_events is append-only via server functions';
END; $$;

DROP TRIGGER IF EXISTS wallet_activation_events_no_update ON public.wallet_activation_events;
CREATE TRIGGER wallet_activation_events_no_update
  BEFORE UPDATE OR DELETE ON public.wallet_activation_events
  FOR EACH ROW EXECUTE FUNCTION public.wallet_activation_events_block_mutation();

CREATE INDEX IF NOT EXISTS wallet_activation_events_user_wallet_ts
  ON public.wallet_activation_events (user_id, wallet_id, server_ts DESC);

-- ==========================================================
-- IDEMPOTENT MONITORING WALLET CREATION RPC
-- ==========================================================
CREATE OR REPLACE FUNCTION public.create_turtle_monitoring_wallets(_user_id uuid)
RETURNS TABLE (
  id uuid,
  wallet_key text,
  direction_scope text,
  balance numeric,
  status text,
  environment text,
  balance_source text,
  monitor_role text,
  execution_enabled boolean,
  activated_at timestamptz,
  created_at timestamptz,
  created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE
  v_jwt_role   text := current_setting('request.jwt.claim.role', true);
  v_pg_role    text := current_setting('role', true);
  v_claims     text := current_setting('request.jwt.claims', true);
  v_is_service boolean := false;
  v_specs      jsonb  := jsonb_build_array(
    jsonb_build_object('key','TURTLE-MONITOR-LONG-01', 'dir','long',  'role','monitor_long'),
    jsonb_build_object('key','TURTLE-MONITOR-SHORT-01','dir','short', 'role','monitor_short')
  );
  v_spec       jsonb;
  v_row        public.paper_wallets%ROWTYPE;
  v_created    boolean;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'user_id required';
  END IF;
  IF COALESCE(v_jwt_role,'') = 'service_role'
     OR (v_claims IS NOT NULL AND v_claims::jsonb ->> 'role' = 'service_role')
     OR COALESCE(v_pg_role,'') = 'service_role'
  THEN v_is_service := true; END IF;

  IF NOT v_is_service THEN
    IF auth.uid() IS NULL OR auth.uid() <> _user_id THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
  END IF;

  FOR v_spec IN SELECT jsonb_array_elements(v_specs) LOOP
    v_created := false;

    SELECT * INTO v_row
      FROM public.paper_wallets
     WHERE user_id = _user_id
       AND wallet_key = (v_spec->>'key')
     FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.paper_wallets (
        user_id, wallet_key, balance, realized_pnl,
        direction_scope, environment, status, balance_source,
        monitor_role, execution_enabled, activated_at, activated_by
      ) VALUES (
        _user_id,
        v_spec->>'key',
        500.00,
        0,
        v_spec->>'dir',
        'paper',
        'monitoring',
        'simulated',
        v_spec->>'role',
        false,          -- execution disabled by default
        now(),
        _user_id
      )
      RETURNING * INTO v_row;

      INSERT INTO public.wallet_activation_events (
        user_id, wallet_id, event, to_state, actor
      ) VALUES (
        _user_id, v_row.id, 'created',
        jsonb_build_object(
          'wallet_key', v_row.wallet_key,
          'direction_scope', v_row.direction_scope,
          'status', v_row.status,
          'environment', v_row.environment,
          'balance_source', v_row.balance_source,
          'execution_enabled', v_row.execution_enabled,
          'balance', v_row.balance
        ),
        CASE WHEN v_is_service THEN 'service' ELSE 'user' END
      );
      v_created := true;
    END IF;

    id                := v_row.id;
    wallet_key        := v_row.wallet_key;
    direction_scope   := v_row.direction_scope;
    balance           := v_row.balance;
    status            := v_row.status;
    environment       := v_row.environment;
    balance_source    := v_row.balance_source;
    monitor_role      := v_row.monitor_role;
    execution_enabled := v_row.execution_enabled;
    activated_at      := v_row.activated_at;
    created_at        := v_row.created_at;
    created           := v_created;
    RETURN NEXT;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_turtle_monitoring_wallets(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_turtle_monitoring_wallets(uuid) TO service_role;

-- ==========================================================
-- OPS EMIT HELPER + SNAPSHOT WRITER
-- ==========================================================
CREATE OR REPLACE FUNCTION public.emit_ops_event(
  _correlation_id uuid,
  _stage text,
  _component text,
  _severity text,
  _message text,
  _detail jsonb DEFAULT NULL,
  _latency_ms integer DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
BEGIN
  IF _correlation_id IS NULL OR _stage IS NULL OR _component IS NULL THEN
    RAISE EXCEPTION 'correlation_id, stage, component required';
  END IF;
  INSERT INTO public.ops_events
    (user_id, correlation_id, stage, component, severity, message, detail, latency_ms)
  VALUES
    (v_uid, _correlation_id, _stage, _component,
     COALESCE(_severity,'info'), COALESCE(_message,''), _detail, _latency_ms)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.emit_ops_event(uuid,text,text,text,text,jsonb,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.emit_ops_event(uuid,text,text,text,text,jsonb,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.record_ops_snapshot(
  _component text,
  _state text,
  _reasons jsonb,
  _last_success_at timestamptz,
  _freshness_ms integer,
  _backlog_count integer,
  _p50_latency_ms integer,
  _p95_latency_ms integer,
  _detail jsonb DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
BEGIN
  IF _component IS NULL OR _state IS NULL THEN
    RAISE EXCEPTION 'component, state required';
  END IF;
  INSERT INTO public.ops_health_snapshots
    (user_id, component, state, reasons, last_success_at, freshness_ms,
     backlog_count, p50_latency_ms, p95_latency_ms, detail)
  VALUES
    (v_uid, _component, _state, COALESCE(_reasons,'[]'::jsonb),
     _last_success_at, _freshness_ms, _backlog_count,
     _p50_latency_ms, _p95_latency_ms, _detail)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_ops_snapshot(text,text,jsonb,timestamptz,integer,integer,integer,integer,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_ops_snapshot(text,text,jsonb,timestamptz,integer,integer,integer,integer,jsonb) TO service_role;
