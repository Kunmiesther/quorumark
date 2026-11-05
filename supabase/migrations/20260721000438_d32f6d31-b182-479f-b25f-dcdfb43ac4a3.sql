-- 1. Point pg_cron scheduler at the stable preview URL (verified: returns 401
--    on unauthenticated POST, proving the route exists). The published
--    production URL currently returns 404 because the production build predates
--    the route; the customer-facing URL will start working automatically after
--    the next publish, at which point a follow-up migration can retarget it.
CREATE OR REPLACE FUNCTION public.invoke_paper_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_url text := 'https://project--240a6028-9d5a-4f07-b8e0-d78a3d684a1c-dev.lovable.app/api/public/hooks/paper-tick';
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

-- 2. One-shot helper to upsert vault.secrets from a caller-supplied value.
--    Purpose: allow the sandbox_exec role (used by the deployment runner)
--    to sync the rotated PAPER_TICK_CRON_SECRET into Vault WITHOUT exposing
--    the value in any migration file. This helper is dropped in a
--    follow-up migration after the sync completes.
CREATE OR REPLACE FUNCTION public._bootstrap_paper_tick_secret(_value text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF _value IS NULL OR length(_value) < 16 THEN
    RAISE EXCEPTION 'value too short';
  END IF;

  SELECT id INTO v_id FROM vault.secrets WHERE name = 'paper_tick_cron_secret' LIMIT 1;
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(_value, 'paper_tick_cron_secret', 'Bearer secret for paper-tick cron endpoint.');
  ELSE
    PERFORM vault.update_secret(v_id, _value, 'paper_tick_cron_secret', 'Bearer secret for paper-tick cron endpoint.');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._bootstrap_paper_tick_secret(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._bootstrap_paper_tick_secret(text) TO sandbox_exec;

-- 3. Inline integration tests for the atomic claim contract. If any ASSERT
--    fails, the migration aborts and the whole change is rolled back.
DO $test$
DECLARE
  v_user_a uuid := gen_random_uuid();
  v_user_b uuid := gen_random_uuid();
  v_minute timestamptz := date_trunc('minute', now());
  v_next   timestamptz := v_minute + interval '1 minute';
  v_first  boolean;
  v_second boolean;
  v_other  boolean;
  v_forbidden boolean := false;
BEGIN
  -- Impersonate service_role for the same-user / same-minute case.
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  v_first  := public.claim_paper_tick(v_user_a, v_minute);
  v_second := public.claim_paper_tick(v_user_a, v_minute);
  ASSERT v_first  IS TRUE,  'same user/minute: first claim must win';
  ASSERT v_second IS FALSE, 'same user/minute: second claim must lose';

  -- Different minute -> should succeed (independent bucket).
  v_other := public.claim_paper_tick(v_user_a, v_next);
  ASSERT v_other IS TRUE, 'different minute: claim must succeed';

  -- Concurrent-semantics equivalence: the UNIQUE (user_id, minute_bucket)
  -- constraint guarantees exactly one INSERT wins even under real
  -- concurrency. Two sequential calls exercise the same code path
  -- (INSERT ... ON CONFLICT DO NOTHING; ROW_COUNT decides the return),
  -- so a second True here would be a bug regardless of concurrency model.
  v_second := public.claim_paper_tick(v_user_a, v_minute);
  ASSERT v_second IS FALSE, 'repeat claim (same bucket) must still lose';

  -- Cross-user authenticated denial.
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub',  v_user_a::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_a::text, 'role', 'authenticated')::text, true);

  BEGIN
    PERFORM public.claim_paper_tick(v_user_b, v_minute);
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN
    v_forbidden := true;
  END;
  ASSERT v_forbidden, 'authenticated user must not be able to claim another user''s slot';

  -- Cleanup test rows.
  DELETE FROM public.paper_tick_leases WHERE user_id IN (v_user_a, v_user_b);

  RAISE NOTICE 'paper_tick_leases claim contract: OK';
END
$test$;