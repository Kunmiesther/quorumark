
-- Switch is_connection_slot_available from SECURITY DEFINER to SECURITY INVOKER.
-- RLS on exchange_connections already scopes SELECT to the caller's own rows,
-- which is exactly what this helper needs to count. Anon has no SELECT on the
-- table, so anon calls return 0 -> true harmlessly; only authenticated callers
-- get a meaningful answer.
CREATE OR REPLACE FUNCTION public.is_connection_slot_available(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT count(*) FROM public.exchange_connections
     WHERE user_id = _user_id
       AND status NOT IN ('disconnected','disabled')),
    0) < 6
$$;

REVOKE ALL ON FUNCTION public.is_connection_slot_available(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_connection_slot_available(uuid) TO authenticated;
