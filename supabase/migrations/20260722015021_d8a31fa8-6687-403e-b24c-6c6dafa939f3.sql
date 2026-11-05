
-- 1) Fix mutable search_path on remaining trigger functions
ALTER FUNCTION public.scout_corrections_block_mutation() SET search_path = public;
ALTER FUNCTION public._venue_capability_audit_no_mutation() SET search_path = public;

-- 2) Revoke EXECUTE from PUBLIC/anon/authenticated on all SECURITY DEFINER functions in public
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef = true
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', r.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', r.sig);
  END LOOP;
END $$;

-- 3) Re-grant EXECUTE to authenticated on RPCs the app actually calls from the client
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_paper_engine_operation(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_paper_engine_operation(uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.emit_ops_event(uuid, text, text, text, text, jsonb, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_paper_wallets(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.scout_persist_scan(uuid, bigint, integer, integer, jsonb) TO authenticated;

-- 4) Explicit owner-scoped SELECT policies on encrypted credential tables
--    (writes stay backend/service-role only; owner can see their own row's metadata)
DROP POLICY IF EXISTS "Owners can view their apex execution credentials" ON public.apex_execution_credentials;
CREATE POLICY "Owners can view their apex execution credentials"
  ON public.apex_execution_credentials
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Owners can view their exchange credentials" ON public.exchange_credentials;
CREATE POLICY "Owners can view their exchange credentials"
  ON public.exchange_credentials
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- 5) Allow signed-in users to delete their own profile row (GDPR / user-initiated removal)
DROP POLICY IF EXISTS "Users delete own profile" ON public.profiles;
CREATE POLICY "Users delete own profile"
  ON public.profiles
  FOR DELETE
  TO authenticated
  USING (auth.uid() = id);
