
-- Convert user-facing my_* wrappers from SECURITY DEFINER to SECURITY INVOKER.
-- Each reads only rows the caller can already see under RLS
-- (auth.uid() = user_id), so no privilege escalation is required.

CREATE OR REPLACE FUNCTION public.my_points_total()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT COALESCE((SELECT sum(points)::int FROM public.point_awards), 0);
$$;

CREATE OR REPLACE FUNCTION public.my_point_awards(p_limit integer DEFAULT 50)
RETURNS SETOF public.point_awards
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT *
    FROM public.point_awards
   ORDER BY awarded_at DESC
   LIMIT GREATEST(COALESCE(p_limit, 50), 0);
$$;

CREATE OR REPLACE FUNCTION public.my_connection_slot_available()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT auth.uid() IS NOT NULL
     AND (
       SELECT count(*) FROM public.exchange_connections
        WHERE status NOT IN ('disconnected','disabled')
     ) < 6;
$$;

CREATE OR REPLACE FUNCTION public.my_confirmed_risk_capital(p_connection_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  -- RLS on both tables restricts rows to auth.uid(); an unowned
  -- p_connection_id therefore yields 0 (fail-closed).
  SELECT CASE
    WHEN auth.uid() IS NULL OR p_connection_id IS NULL THEN 0::numeric
    WHEN NOT EXISTS (
      SELECT 1 FROM public.exchange_connections
       WHERE id = p_connection_id
         AND status NOT IN ('disconnected','disabled')
    ) THEN 0::numeric
    ELSE COALESCE((
      SELECT sum(amount)
        FROM public.risk_capital_allocations
       WHERE connection_id = p_connection_id
         AND status = 'confirmed'
    ), 0)::numeric
  END;
$$;

CREATE OR REPLACE FUNCTION public.my_risk_capital_summary()
RETURNS TABLE(connection_id uuid, allocated numeric, status text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT ec.id AS connection_id,
         COALESCE(SUM(rca.amount) FILTER (WHERE rca.status = 'confirmed'), 0)::numeric AS allocated,
         CASE
           WHEN bool_or(rca.status = 'confirmed') THEN 'confirmed'
           WHEN bool_or(rca.status IS NOT NULL)   THEN 'unconfirmed'
           ELSE 'none'
         END::text AS status
    FROM public.exchange_connections ec
    LEFT JOIN public.risk_capital_allocations rca
      ON rca.connection_id = ec.id
   WHERE ec.status NOT IN ('disconnected','disabled')
   GROUP BY ec.id;
$$;

CREATE OR REPLACE FUNCTION public.my_execution_halted(p_connection_id uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  -- Fail-closed rules (RLS enforces the ownership filter transparently):
  --   * unauthenticated  -> halted
  --   * connection id passed but not visible to caller -> halted
  --   * any matching global/user/connection kill switch -> halted
  SELECT CASE
    WHEN auth.uid() IS NULL THEN true
    WHEN p_connection_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.exchange_connections WHERE id = p_connection_id
      ) THEN true
    ELSE EXISTS (
      SELECT 1 FROM public.kill_switches
       WHERE active = true
         AND (
           scope = 'global'
           OR (scope = 'user'       AND user_id = auth.uid())
           OR (scope = 'connection' AND user_id = auth.uid() AND connection_id = p_connection_id)
         )
    )
  END;
$$;

-- Preserve the existing narrow grants (authenticated-only).
REVOKE ALL ON FUNCTION public.my_points_total()                         FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_point_awards(integer)                  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_connection_slot_available()            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_confirmed_risk_capital(uuid)           FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_risk_capital_summary()                 FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_execution_halted(uuid)                 FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.my_points_total()               TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_point_awards(integer)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_connection_slot_available()  TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_confirmed_risk_capital(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_risk_capital_summary()       TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_execution_halted(uuid)       TO authenticated;
