-- Harden is_execution_halted so it can be safely called by authenticated
-- users: caller may only query their own uid (else fail-closed = halted).
CREATE OR REPLACE FUNCTION public.is_execution_halted(p_user_id uuid, p_connection_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p_user_id IS NULL THEN true
    -- Authenticated callers may only query their own status; anything else
    -- (including anon or spoofed uid) is treated as HALTED.
    WHEN auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN true
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
$function$;

GRANT EXECUTE ON FUNCTION public.is_execution_halted(uuid, uuid) TO authenticated;