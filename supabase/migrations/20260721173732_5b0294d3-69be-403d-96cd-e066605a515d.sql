
-- ============================================================
-- 1. UNWIND the previous blanket global cross-only enforcement
--    (columns are retained; history for opened_margin_mode is
--    still immutable).
-- ============================================================

ALTER TABLE public.user_strategy
  DROP CONSTRAINT IF EXISTS user_strategy_margin_mode_cross_only;
ALTER TABLE public.paper_positions
  DROP CONSTRAINT IF EXISTS paper_positions_opened_margin_mode_check;
ALTER TABLE public.order_intents
  DROP CONSTRAINT IF EXISTS order_intents_margin_mode_cross_only;

DROP TRIGGER IF EXISTS user_strategy_enforce_cross_trg  ON public.user_strategy;
DROP TRIGGER IF EXISTS order_intents_enforce_cross_trg  ON public.order_intents;

-- Historical preservation trigger stays. Rename fn if present, otherwise
-- create a plain immutability guard.
DROP TRIGGER IF EXISTS paper_positions_opened_margin_immutable_trg ON public.paper_positions;

CREATE OR REPLACE FUNCTION public._paper_positions_opened_margin_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.opened_margin_mode IS DISTINCT FROM OLD.opened_margin_mode THEN
    RAISE EXCEPTION 'opened_margin_mode is immutable historical fact';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER paper_positions_opened_margin_immutable_trg
BEFORE UPDATE ON public.paper_positions
FOR EACH ROW EXECUTE FUNCTION public._paper_positions_opened_margin_immutable();

-- Drop the leftover enforce fns from the previous migration if they exist.
DROP FUNCTION IF EXISTS public._user_strategy_enforce_cross();
DROP FUNCTION IF EXISTS public._order_intents_enforce_cross();

-- Loosen defaults: 'cross' still a reasonable default because our only
-- currently-connected exchange (ApeX) is cross-only, but nullability +
-- values are now capability-driven.
ALTER TABLE public.user_strategy ALTER COLUMN margin_mode DROP NOT NULL;
ALTER TABLE public.order_intents  ALTER COLUMN margin_mode DROP NOT NULL;

-- ============================================================
-- 2. VENUE CAPABILITY REGISTRY (versioned, TTL'd, verified)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.venue_capabilities (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id          uuid REFERENCES public.exchange_connections(id) ON DELETE CASCADE,
  exchange               text NOT NULL,
  adapter_version        text NOT NULL,
  environment            text NOT NULL,
  market_type            text NOT NULL,
  position_mode          text NOT NULL DEFAULT 'one_way',
  symbol                 text,
  capabilities           jsonb NOT NULL,
  source                 text NOT NULL,
  exchange_response_code text,
  verification_status    text NOT NULL DEFAULT 'unverified',
  retrieved_at           timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT venue_capabilities_source_ck CHECK (
    source IN ('adapter_static','handshake','account_info','product_metadata')
  ),
  CONSTRAINT venue_capabilities_verification_ck CHECK (
    verification_status IN ('verified','unverified','stale','degraded','rejected')
  ),
  CONSTRAINT venue_capabilities_position_mode_ck CHECK (
    position_mode IN ('one_way','hedge','unknown')
  ),
  CONSTRAINT venue_capabilities_market_type_ck CHECK (
    market_type IN ('spot','futures','margin','unknown')
  ),
  CONSTRAINT venue_capabilities_scope_ck CHECK (
    -- static adapter defaults are user-less and connection-less
    (source = 'adapter_static' AND user_id IS NULL AND connection_id IS NULL)
    OR (source <> 'adapter_static' AND user_id IS NOT NULL AND connection_id IS NOT NULL)
  )
);

-- Unique composite key. NULLs in symbol/connection collapse to sentinels
-- so we get exactly one active row per capability scope.
CREATE UNIQUE INDEX IF NOT EXISTS venue_capabilities_scope_key
  ON public.venue_capabilities (
    exchange, adapter_version, environment, market_type, position_mode,
    COALESCE(symbol, '*'),
    COALESCE(connection_id::text, '*'),
    COALESCE(user_id::text, '*')
  );

CREATE INDEX IF NOT EXISTS venue_capabilities_conn_idx
  ON public.venue_capabilities (connection_id);
CREATE INDEX IF NOT EXISTS venue_capabilities_expiry_idx
  ON public.venue_capabilities (expires_at);

GRANT SELECT ON public.venue_capabilities TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.venue_capabilities TO authenticated;
GRANT ALL ON public.venue_capabilities TO service_role;

ALTER TABLE public.venue_capabilities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read static adapter caps (anon+auth)"
  ON public.venue_capabilities FOR SELECT
  USING (source = 'adapter_static' AND user_id IS NULL);

CREATE POLICY "read own runtime caps"
  ON public.venue_capabilities FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "insert own runtime caps"
  ON public.venue_capabilities FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND source <> 'adapter_static'
    AND connection_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.exchange_connections ec
      WHERE ec.id = connection_id AND ec.user_id = auth.uid()
    )
  );

CREATE POLICY "update own runtime caps"
  ON public.venue_capabilities FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid() AND source <> 'adapter_static')
  WITH CHECK (user_id = auth.uid() AND source <> 'adapter_static');

CREATE POLICY "delete own runtime caps"
  ON public.venue_capabilities FOR DELETE
  TO authenticated
  USING (user_id = auth.uid() AND source <> 'adapter_static');

CREATE TRIGGER venue_capabilities_touch
BEFORE UPDATE ON public.venue_capabilities
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- 3. VENUE CAPABILITY AUDIT (append-only)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.venue_capability_audit (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  connection_id  uuid REFERENCES public.exchange_connections(id) ON DELETE SET NULL,
  exchange       text NOT NULL,
  event          text NOT NULL,
  reason_code    text NOT NULL,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT venue_capability_audit_event_ck CHECK (
    event IN ('lookup','refresh','drift','rejected','preflight_pass','preflight_fail')
  )
);

CREATE INDEX IF NOT EXISTS venue_capability_audit_user_idx
  ON public.venue_capability_audit (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS venue_capability_audit_conn_idx
  ON public.venue_capability_audit (connection_id, created_at DESC);

GRANT SELECT ON public.venue_capability_audit TO authenticated;
GRANT INSERT, SELECT ON public.venue_capability_audit TO authenticated;
GRANT ALL ON public.venue_capability_audit TO service_role;

ALTER TABLE public.venue_capability_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read own capability audit"
  ON public.venue_capability_audit FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "insert own capability audit"
  ON public.venue_capability_audit FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public._venue_capability_audit_no_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'venue_capability_audit is append-only; % not permitted', TG_OP;
END;
$$;

CREATE TRIGGER venue_capability_audit_no_update
BEFORE UPDATE OR DELETE ON public.venue_capability_audit
FOR EACH ROW EXECUTE FUNCTION public._venue_capability_audit_no_mutation();

-- ============================================================
-- 4. SEED STATIC ADAPTER CAPABILITIES
--    Documented defaults. Runtime handshake still required before
--    execution — these rows are `unverified`.
-- ============================================================

INSERT INTO public.venue_capabilities (
  user_id, connection_id, exchange, adapter_version, environment,
  market_type, position_mode, symbol, capabilities, source,
  verification_status, retrieved_at, expires_at
) VALUES
  -- ApeX Omni: CROSS only, one-way, USDT-perp
  (NULL, NULL, 'apex_omni', 'v1', 'test', 'futures', 'one_way', NULL,
   jsonb_build_object(
     'allowed_margin_modes', jsonb_build_array('cross'),
     'hedge_supported', false,
     'reduce_only', true,
     'order_types', jsonb_build_array('limit','market','limit_maker'),
     'leverage_range', jsonb_build_object('min', 1, 'max', 100),
     'note', 'ApeX Omni USDT perpetuals — cross margin only.'
   ),
   'adapter_static', 'unverified', now(), NULL),
  (NULL, NULL, 'apex_omni', 'v1', 'prod', 'futures', 'one_way', NULL,
   jsonb_build_object(
     'allowed_margin_modes', jsonb_build_array('cross'),
     'hedge_supported', false,
     'reduce_only', true,
     'order_types', jsonb_build_array('limit','market','limit_maker'),
     'leverage_range', jsonb_build_object('min', 1, 'max', 100)
   ),
   'adapter_static', 'unverified', now(), NULL),
  -- BYDFi futures: both modes documented; must be re-confirmed per account/product
  (NULL, NULL, 'bydfi', 'v1', 'test', 'futures', 'one_way', NULL,
   jsonb_build_object(
     'allowed_margin_modes', jsonb_build_array('cross','isolated'),
     'hedge_supported', true,
     'reduce_only', true,
     'order_types', jsonb_build_array('limit','market'),
     'leverage_range', jsonb_build_object('min', 1, 'max', 125),
     'requires_runtime_confirmation', true
   ),
   'adapter_static', 'unverified', now(), NULL),
  (NULL, NULL, 'bydfi', 'v1', 'prod', 'futures', 'one_way', NULL,
   jsonb_build_object(
     'allowed_margin_modes', jsonb_build_array('cross','isolated'),
     'hedge_supported', true,
     'reduce_only', true,
     'order_types', jsonb_build_array('limit','market'),
     'leverage_range', jsonb_build_object('min', 1, 'max', 125),
     'requires_runtime_confirmation', true
   ),
   'adapter_static', 'unverified', now(), NULL),
  -- BTCC futures
  (NULL, NULL, 'btcc', 'v1', 'test', 'futures', 'one_way', NULL,
   jsonb_build_object(
     'allowed_margin_modes', jsonb_build_array('cross','isolated'),
     'hedge_supported', true,
     'reduce_only', true,
     'order_types', jsonb_build_array('limit','market'),
     'leverage_range', jsonb_build_object('min', 1, 'max', 150),
     'requires_runtime_confirmation', true
   ),
   'adapter_static', 'unverified', now(), NULL),
  (NULL, NULL, 'btcc', 'v1', 'prod', 'futures', 'one_way', NULL,
   jsonb_build_object(
     'allowed_margin_modes', jsonb_build_array('cross','isolated'),
     'hedge_supported', true,
     'reduce_only', true,
     'order_types', jsonb_build_array('limit','market'),
     'leverage_range', jsonb_build_object('min', 1, 'max', 150),
     'requires_runtime_confirmation', true
   ),
   'adapter_static', 'unverified', now(), NULL)
ON CONFLICT DO NOTHING;
