CREATE OR REPLACE FUNCTION public.claim_paper_engine_operation(_user_id uuid, _op_key text, _fingerprint text)
RETURNS TABLE(status text, result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_jwt_role   text := current_setting('request.jwt.claim.role', true);
  v_pg_role    text := current_setting('role', true);
  v_claims     text := current_setting('request.jwt.claims', true);
  v_is_service boolean := false;
  v_inserted   int;
  v_row        public.paper_engine_operations%ROWTYPE;
BEGIN
  IF _user_id IS NULL OR _op_key IS NULL OR _fingerprint IS NULL THEN
    RAISE EXCEPTION 'user_id, op_key, fingerprint required';
  END IF;

  IF COALESCE(v_jwt_role, '') = 'service_role'
     OR (v_claims IS NOT NULL AND v_claims::jsonb ->> 'role' = 'service_role')
     OR COALESCE(v_pg_role, '') = 'service_role'
  THEN
    v_is_service := true;
  END IF;

  IF NOT v_is_service THEN
    IF auth.uid() IS NULL OR auth.uid() <> _user_id THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
  END IF;

  WITH ins AS (
    INSERT INTO public.paper_engine_operations (user_id, op_key, fingerprint)
    VALUES (_user_id, _op_key, _fingerprint)
    ON CONFLICT (user_id, op_key) DO NOTHING
    RETURNING id
  )
  SELECT count(*)::int INTO v_inserted FROM ins;

  IF v_inserted = 1 THEN
    RETURN QUERY SELECT 'claimed'::text, NULL::jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_row
    FROM public.paper_engine_operations
   WHERE user_id = _user_id AND op_key = _op_key;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'claim state inconsistent';
  END IF;

  -- A dead-lettered operation means the atomic mutation was REJECTED before
  -- completion, so nothing was persisted. After a short cool-off the slot is
  -- reclaimable; without this it stayed poisoned forever (same fingerprint =>
  -- bogus "replayed" with a null result, different fingerprint => "conflict").
  IF v_row.state = 'dead_letter' THEN
    IF v_row.recovered_at IS NOT NULL AND v_row.recovered_at > now() - interval '2 minutes' THEN
      RETURN QUERY SELECT 'conflict'::text, NULL::jsonb;
      RETURN;
    END IF;
    UPDATE public.paper_engine_operations
       SET state = 'claimed',
           fingerprint = _fingerprint,
           result = NULL,
           recovery_reason = NULL,
           recovered_at = NULL,
           claimed_at = now(),
           updated_at = now()
     WHERE user_id = _user_id AND op_key = _op_key;
    RETURN QUERY SELECT 'claimed'::text, NULL::jsonb;
    RETURN;
  END IF;

  IF v_row.fingerprint <> _fingerprint THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::jsonb;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'replayed'::text, v_row.result;
END;
$fn$;

-- The zombie-reclaim guard must not fire for the controlled reset above.
CREATE OR REPLACE FUNCTION public.paper_engine_ops_block_zombie_reclaim()
RETURNS trigger
LANGUAGE plpgsql
AS $t$
BEGIN
  IF OLD.state='dead_letter' AND NEW.state='claimed'
     AND OLD.fingerprint=NEW.fingerprint
     AND OLD.recovery_reason IS NOT NULL
     AND NEW.recovery_reason IS NOT NULL THEN
    RAISE EXCEPTION 'op_key % is dead_lettered (%); explicit reset required',
      OLD.op_key, OLD.recovery_reason USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$t$;