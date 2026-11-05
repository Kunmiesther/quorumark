
-- 1. order_audit table (append-only)
CREATE TABLE public.order_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  connection_id uuid,
  idempotency_key text,
  phase text NOT NULL CHECK (phase IN ('received','validated','rejected','submitted','exchange_response')),
  venue text,
  symbol text,
  side text,
  order_type text,
  size numeric,
  price numeric,
  leverage numeric,
  is_live boolean,
  reject_reason text,
  exchange_order_id text,
  exchange_status text,
  sanitized_response jsonb
);

GRANT SELECT, INSERT ON public.order_audit TO service_role;
GRANT SELECT ON public.order_audit TO authenticated;

ALTER TABLE public.order_audit ENABLE ROW LEVEL SECURITY;

-- Owner can read their own rows.
CREATE POLICY "Users read own audit rows"
  ON public.order_audit
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Service role can insert (no policy needed since service_role bypasses RLS,
-- but keep explicit INSERT policy off — service role bypasses).
-- No UPDATE, no DELETE policies exist for any role.

-- Hard block: raise on UPDATE / DELETE even for service_role.
CREATE OR REPLACE FUNCTION public.order_audit_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'order_audit is append-only; % is not permitted', TG_OP;
END;
$$;

CREATE TRIGGER order_audit_no_update
  BEFORE UPDATE ON public.order_audit
  FOR EACH ROW EXECUTE FUNCTION public.order_audit_block_mutation();

CREATE TRIGGER order_audit_no_delete
  BEFORE DELETE ON public.order_audit
  FOR EACH ROW EXECUTE FUNCTION public.order_audit_block_mutation();

-- Indexes
CREATE INDEX order_audit_user_created_idx
  ON public.order_audit (user_id, created_at DESC);

CREATE UNIQUE INDEX order_audit_idem_phase_uniq
  ON public.order_audit (idempotency_key, phase)
  WHERE idempotency_key IS NOT NULL;

-- 2. active_bot_config view (secrets-free)
CREATE OR REPLACE VIEW public.active_bot_config AS
SELECT
  us.user_id,
  ec.exchange       AS exchange_type,
  COALESCE(us.params->>'symbol', 'BTC-USDT') AS symbol,
  us.market_type::text AS market_type,
  us.cross_margin,
  us.params,
  us.enabled,
  us.mode,
  ec.id             AS connection_id,
  ec.permission_trade,
  ec.permissions_verified,
  ec.environment,
  ec.status::text   AS status
FROM public.user_strategy us
JOIN public.profiles p          ON p.id = us.user_id
LEFT JOIN public.exchange_connections ec ON ec.user_id = us.user_id;

REVOKE ALL ON public.active_bot_config FROM PUBLIC;
REVOKE ALL ON public.active_bot_config FROM authenticated, anon;
GRANT SELECT ON public.active_bot_config TO service_role;
