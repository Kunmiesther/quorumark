
-- 1. Lease table: one row per (user_id, minute_bucket) — atomic claim via unique PK
CREATE TABLE IF NOT EXISTS public.paper_tick_leases (
  user_id UUID NOT NULL,
  minute_bucket TIMESTAMPTZ NOT NULL,
  claimed_by TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, minute_bucket)
);

GRANT SELECT ON public.paper_tick_leases TO authenticated;
GRANT ALL ON public.paper_tick_leases TO service_role;

ALTER TABLE public.paper_tick_leases ENABLE ROW LEVEL SECURITY;

-- Users can only see their own leases (diagnostic). Writes go through the SECURITY DEFINER RPC.
CREATE POLICY "own leases readable" ON public.paper_tick_leases
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_paper_tick_leases_claimed_at
  ON public.paper_tick_leases (claimed_at);

-- 2. Atomic claim RPC.
--    - Truncates the timestamp to the minute so callers can't split hairs.
--    - Ordinary authenticated users may only claim rows for themselves.
--    - service_role (cron, server route with service key) may claim any user.
--    - Returns TRUE if this call won the lease, FALSE if another call already had it.
CREATE OR REPLACE FUNCTION public.claim_paper_tick(
  _user_id UUID,
  _bucket TIMESTAMPTZ DEFAULT now()
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_bucket TIMESTAMPTZ := date_trunc('minute', _bucket);
  v_caller TEXT := current_setting('request.jwt.claim.role', true);
  v_inserted INT;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'user_id required';
  END IF;

  -- Authorization: service_role can claim any user; everyone else must be that user.
  IF COALESCE(v_caller, '') <> 'service_role' THEN
    IF auth.uid() IS NULL OR auth.uid() <> _user_id THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO public.paper_tick_leases (user_id, minute_bucket, claimed_by)
  VALUES (_user_id, v_bucket, COALESCE(v_caller, 'authenticated'))
  ON CONFLICT (user_id, minute_bucket) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_paper_tick(UUID, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_paper_tick(UUID, TIMESTAMPTZ) TO authenticated, service_role;

-- 3. Retention: delete leases older than 1 day. Scheduled hourly via pg_cron.
CREATE OR REPLACE FUNCTION public.cleanup_paper_tick_leases()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  DELETE FROM public.paper_tick_leases WHERE claimed_at < now() - INTERVAL '1 day';
$$;

REVOKE ALL ON FUNCTION public.cleanup_paper_tick_leases() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'paper-tick-leases-cleanup') THEN
    PERFORM cron.unschedule('paper-tick-leases-cleanup');
  END IF;
END $$;

SELECT cron.schedule(
  'paper-tick-leases-cleanup',
  '17 * * * *',
  $cron$SELECT public.cleanup_paper_tick_leases();$cron$
);

-- 4. Rewire pg_cron scheduler to authenticate via Bearer secret from Vault.
--    Fails closed (skips POST) if secret not present in Vault. NEVER sends anon key.
CREATE OR REPLACE FUNCTION public.invoke_paper_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_url text := 'https://project--240a6028-9d5a-4f07-b8e0-d78a3d684a1c.lovable.app/api/public/hooks/paper-tick';
  v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
   WHERE name = 'paper_tick_cron_secret'
   LIMIT 1;

  IF v_secret IS NULL OR length(v_secret) = 0 THEN
    RAISE NOTICE 'invoke_paper_tick: paper_tick_cron_secret not set in Vault; skipping.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     => v_url,
    headers => jsonb_build_object(
      'content-type', 'application/json',
      'authorization', 'Bearer ' || v_secret
    ),
    body    => '{}'::jsonb,
    timeout_milliseconds => 20000
  );
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_paper_tick() FROM PUBLIC, anon, authenticated;
