
-- 1) Fail-closed is_execution_halted
CREATE OR REPLACE FUNCTION public.is_execution_halted(p_user_id uuid, p_connection_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  -- Ownership mismatch or null user is treated as HALTED (fail-closed);
  -- never as permission to trade.
  SELECT CASE
    WHEN p_user_id IS NULL THEN true
    WHEN p_connection_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.exchange_connections
        WHERE id = p_connection_id AND user_id = p_user_id
      ) THEN true
    ELSE EXISTS (
      SELECT 1 FROM public.kill_switches
      WHERE active = true
        AND (
          scope = 'global'
          OR (scope = 'user'       AND user_id = p_user_id)
          OR (scope = 'connection' AND user_id = p_user_id AND connection_id = p_connection_id)
        )
    )
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.is_execution_halted(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_execution_halted(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_execution_halted(uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.is_execution_halted(uuid, uuid) TO service_role;

-- 2) User-scoped halt RPC for the UI
CREATE OR REPLACE FUNCTION public.my_execution_halted(p_connection_id uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RETURN true; -- fail-closed
  END IF;
  IF p_connection_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.exchange_connections WHERE id = p_connection_id AND user_id = uid
  ) THEN
    RETURN true; -- fail-closed on ownership mismatch
  END IF;
  RETURN public.is_execution_halted(uid, p_connection_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.my_execution_halted(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.my_execution_halted(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.my_execution_halted(uuid) TO authenticated;

-- 3) Tighten is_connection_slot_available and add user-scoped variant
REVOKE EXECUTE ON FUNCTION public.is_connection_slot_available(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_connection_slot_available(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_connection_slot_available(uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.is_connection_slot_available(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.my_connection_slot_available()
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.is_connection_slot_available(uid);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.my_connection_slot_available() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.my_connection_slot_available() FROM anon;
GRANT  EXECUTE ON FUNCTION public.my_connection_slot_available() TO authenticated;
