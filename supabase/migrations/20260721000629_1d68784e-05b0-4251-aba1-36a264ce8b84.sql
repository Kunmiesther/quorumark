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
  v_jwt_role TEXT := current_setting('request.jwt.claim.role', true);
  v_pg_role  TEXT := current_setting('role', true);
  v_claims   TEXT := current_setting('request.jwt.claims', true);
  v_is_service BOOLEAN := FALSE;
  v_inserted INT;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'user_id required';
  END IF;

  -- service_role identification: PostgREST versions differ in whether they
  -- set per-claim GUCs or only the aggregate JSON. Accept any of:
  --   (a) request.jwt.claim.role = service_role  (older PostgREST)
  --   (b) request.jwt.claims contains "role":"service_role"  (newer PostgREST)
  --   (c) current Postgres role is service_role  (direct SQL / cron)
  IF COALESCE(v_jwt_role, '') = 'service_role'
     OR (v_claims IS NOT NULL AND v_claims::jsonb ->> 'role' = 'service_role')
     OR COALESCE(v_pg_role, '') = 'service_role'
  THEN
    v_is_service := TRUE;
  END IF;

  IF NOT v_is_service THEN
    IF auth.uid() IS NULL OR auth.uid() <> _user_id THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO public.paper_tick_leases (user_id, minute_bucket, claimed_by)
  VALUES (_user_id, v_bucket, CASE WHEN v_is_service THEN 'service_role' ELSE 'authenticated' END)
  ON CONFLICT (user_id, minute_bucket) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_paper_tick(UUID, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_paper_tick(UUID, TIMESTAMPTZ) TO authenticated, service_role;

-- Re-run the integration contract against the updated function.
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
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  v_first  := public.claim_paper_tick(v_user_a, v_minute);
  v_second := public.claim_paper_tick(v_user_a, v_minute);
  ASSERT v_first  IS TRUE,  'same user/minute: first claim must win';
  ASSERT v_second IS FALSE, 'same user/minute: second claim must lose';

  v_other := public.claim_paper_tick(v_user_a, v_next);
  ASSERT v_other IS TRUE, 'different minute: claim must succeed';

  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_a::text, 'role', 'authenticated')::text, true);

  BEGIN
    PERFORM public.claim_paper_tick(v_user_b, v_minute);
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN
    v_forbidden := true;
  END;
  ASSERT v_forbidden, 'authenticated user must not be able to claim another user''s slot';

  DELETE FROM public.paper_tick_leases WHERE user_id IN (v_user_a, v_user_b);
  RAISE NOTICE 'claim_paper_tick contract (updated): OK';
END
$test$;