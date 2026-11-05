
-- P3-AMEND: Risk capital is PER CONNECTION.
-- The $500 cap is enforced independently for each connection_id.
-- There is deliberately NO user-wide aggregate cap; the $3,000 aggregate
-- is emergent from the 6-connection cap (P1). Allocation is never
-- borrowed across connections. Leverage may raise notional exposure but
-- allocated margin per connection may never exceed $500.

-- 1. Add nullable connection_id (RESTRICT: preserve audit trail).
ALTER TABLE public.risk_capital_allocations
  ADD COLUMN IF NOT EXISTS connection_id uuid
    REFERENCES public.exchange_connections(id) ON DELETE RESTRICT;

-- 2. Backfill genuine existing data only: oldest connection per user.
UPDATE public.risk_capital_allocations rca
   SET connection_id = sub.conn_id
  FROM (
    SELECT DISTINCT ON (ec.user_id) ec.user_id, ec.id AS conn_id
      FROM public.exchange_connections ec
     ORDER BY ec.user_id, ec.created_at ASC, ec.id ASC
  ) sub
 WHERE rca.connection_id IS NULL
   AND rca.user_id = sub.user_id;

-- 3. Replace the per-user unique index with a per-connection one.
DROP INDEX IF EXISTS public.risk_capital_allocations_one_confirmed_per_user;
CREATE UNIQUE INDEX IF NOT EXISTS risk_capital_allocations_one_confirmed_per_connection
  ON public.risk_capital_allocations (user_id, connection_id)
  WHERE status = 'confirmed';

-- 4. Per-connection $500 cap. NOT VALID then VALIDATE — will error out
--    rather than silently corrupting if genuine data violates it.
ALTER TABLE public.risk_capital_allocations
  DROP CONSTRAINT IF EXISTS risk_capital_allocations_max_500_per_connection;
ALTER TABLE public.risk_capital_allocations
  ADD CONSTRAINT risk_capital_allocations_max_500_per_connection
    CHECK (amount >= 0 AND amount <= 500) NOT VALID;
ALTER TABLE public.risk_capital_allocations
  VALIDATE CONSTRAINT risk_capital_allocations_max_500_per_connection;

-- 5. Lookup index.
CREATE INDEX IF NOT EXISTS risk_capital_allocations_user_connection_idx
  ON public.risk_capital_allocations (user_id, connection_id);

COMMENT ON COLUMN public.risk_capital_allocations.connection_id IS
  'Per-connection risk capital: the $500 cap is enforced independently by connection_id. No user-wide aggregate cap exists; $3,000 max is emergent from 6 connections. Allocation is never borrowed across connections.';

-- 7. Replace confirmed_risk_capital(uuid) with (uuid, uuid). Fail closed.
DROP FUNCTION IF EXISTS public.confirmed_risk_capital(uuid);

CREATE OR REPLACE FUNCTION public.confirmed_risk_capital(p_user_id uuid, p_connection_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_user_id IS NULL OR p_connection_id IS NULL THEN 0::numeric
    WHEN NOT EXISTS (
      SELECT 1 FROM public.exchange_connections
       WHERE id = p_connection_id AND user_id = p_user_id
    ) THEN 0::numeric
    ELSE COALESCE((
      SELECT sum(amount)
        FROM public.risk_capital_allocations
       WHERE user_id = p_user_id
         AND connection_id = p_connection_id
         AND status = 'confirmed'
    ), 0)::numeric
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.confirmed_risk_capital(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.confirmed_risk_capital(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.confirmed_risk_capital(uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.confirmed_risk_capital(uuid, uuid) TO service_role;

-- 8. Replace my_confirmed_risk_capital() with (uuid). Fail closed.
DROP FUNCTION IF EXISTS public.my_confirmed_risk_capital();

CREATE OR REPLACE FUNCTION public.my_confirmed_risk_capital(p_connection_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE uid uuid := auth.uid();
BEGIN
  IF uid IS NULL OR p_connection_id IS NULL THEN
    RETURN 0;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.exchange_connections
     WHERE id = p_connection_id AND user_id = uid
  ) THEN
    RETURN 0;
  END IF;
  RETURN public.confirmed_risk_capital(uid, p_connection_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.my_confirmed_risk_capital(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.my_confirmed_risk_capital(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.my_confirmed_risk_capital(uuid) TO authenticated;

-- 9. New per-user summary — one row per owned connection.
CREATE OR REPLACE FUNCTION public.my_risk_capital_summary()
RETURNS TABLE(connection_id uuid, allocated numeric, status text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT ec.id AS connection_id,
           COALESCE(SUM(rca.amount) FILTER (WHERE rca.status = 'confirmed'), 0)::numeric AS allocated,
           CASE
             WHEN bool_or(rca.status = 'confirmed') THEN 'confirmed'
             WHEN bool_or(rca.status IS NOT NULL)   THEN 'unconfirmed'
             ELSE 'none'
           END::text AS status
      FROM public.exchange_connections ec
      LEFT JOIN public.risk_capital_allocations rca
        ON rca.connection_id = ec.id AND rca.user_id = uid
     WHERE ec.user_id = uid
     GROUP BY ec.id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.my_risk_capital_summary() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.my_risk_capital_summary() FROM anon;
GRANT  EXECUTE ON FUNCTION public.my_risk_capital_summary() TO authenticated;
