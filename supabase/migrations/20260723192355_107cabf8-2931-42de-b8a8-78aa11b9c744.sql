
-- 1. exchange_leverage_caps: restrict to authenticated
DROP POLICY IF EXISTS "anyone can read leverage caps" ON public.exchange_leverage_caps;
REVOKE SELECT ON public.exchange_leverage_caps FROM anon;
GRANT SELECT ON public.exchange_leverage_caps TO authenticated;
CREATE POLICY "authenticated can read leverage caps"
  ON public.exchange_leverage_caps FOR SELECT TO authenticated USING (true);

-- 2. venue_capabilities: restrict static caps to authenticated only
DROP POLICY IF EXISTS "read static adapter caps (anon+auth)" ON public.venue_capabilities;
REVOKE SELECT ON public.venue_capabilities FROM anon;
CREATE POLICY "read static adapter caps (auth)"
  ON public.venue_capabilities FOR SELECT TO authenticated
  USING (source = 'adapter_static' AND user_id IS NULL);

-- 3. kill_switches_legacy: revoke all app grants, add explicit deny-by-default (no policies -> no access under RLS)
REVOKE ALL ON public.kill_switches_legacy FROM anon, authenticated, PUBLIC;
GRANT ALL ON public.kill_switches_legacy TO service_role;
-- explicit restrictive policy so any future permissive policy cannot accidentally open reads
CREATE POLICY "no client access to kill_switches_legacy"
  ON public.kill_switches_legacy AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

-- 4. wallet_connections: add owner write policies
CREATE POLICY "Users can insert their own wallet connections"
  ON public.wallet_connections FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own wallet connections"
  ON public.wallet_connections FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete their own wallet connections"
  ON public.wallet_connections FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- 5. worker_ingest_nonces + worker_registry: revoke grants; restrictive policy against client roles
REVOKE ALL ON public.worker_ingest_nonces FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.worker_registry FROM anon, authenticated, PUBLIC;
GRANT ALL ON public.worker_ingest_nonces TO service_role;
GRANT ALL ON public.worker_registry TO service_role;
ALTER TABLE public.worker_ingest_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_registry ENABLE ROW LEVEL SECURITY;
CREATE POLICY "no client access to worker_ingest_nonces"
  ON public.worker_ingest_nonces AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY "no client access to worker_registry"
  ON public.worker_registry AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);
