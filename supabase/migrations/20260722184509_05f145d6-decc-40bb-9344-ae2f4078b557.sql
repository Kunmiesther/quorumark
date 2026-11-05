
-- 1. Tighten SELECT policies: system rows (user_id IS NULL) admin-only
DROP POLICY IF EXISTS "Users read own margin policy events" ON public.margin_policy_events;
CREATE POLICY "Users read own margin policy events"
  ON public.margin_policy_events
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR (user_id IS NULL AND public.has_role(auth.uid(), 'admin'))
  );

DROP POLICY IF EXISTS "ops_events select own" ON public.ops_events;
CREATE POLICY "ops_events select own"
  ON public.ops_events
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id
    OR (user_id IS NULL AND public.has_role(auth.uid(), 'admin'))
  );

DROP POLICY IF EXISTS "ops_health select own" ON public.ops_health_snapshots;
CREATE POLICY "ops_health select own"
  ON public.ops_health_snapshots
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id
    OR (user_id IS NULL AND public.has_role(auth.uid(), 'admin'))
  );

-- 2. Revoke EXECUTE from authenticated on SECURITY DEFINER fns that
-- the app now invokes exclusively via the service_role admin client.
-- `has_role` remains executable by authenticated because RLS policies
-- across the schema call it during query planning.
REVOKE EXECUTE ON FUNCTION public.claim_paper_engine_operation(uuid, text, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_paper_engine_operation(uuid, text, jsonb) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.emit_ops_event(uuid, text, text, text, text, jsonb, integer) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.ensure_paper_wallets(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.scout_persist_scan(uuid, bigint, integer, integer, jsonb) FROM authenticated;
