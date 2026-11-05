-- Kill-switch execution-guard hardening (Part A).
--
-- Ensure `public.is_execution_halted(uuid, uuid)` is callable ONLY by the
-- server role that the worker-ingest edge function uses. The function is
-- SECURITY DEFINER with a fixed search_path (already set previously); this
-- migration makes the grants explicit and idempotent.

REVOKE ALL ON FUNCTION public.is_execution_halted(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_execution_halted(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.is_execution_halted(uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.is_execution_halted(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.is_execution_halted(uuid, uuid) IS
  'Internal kill-switch evaluator. Callable only by service_role via the signed worker-ingest EXECUTION_GUARD_READ path. Never expose to anon or authenticated.';
