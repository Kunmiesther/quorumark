
REVOKE EXECUTE ON FUNCTION public.is_execution_halted(uuid, uuid) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.is_execution_halted(uuid, uuid) TO service_role;
