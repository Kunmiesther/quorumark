
-- Phase 4A: durable paper engine operations table + least-privilege claim/complete RPCs.
-- Append-only from the app: writes only via SECURITY DEFINER functions below.

CREATE TABLE public.paper_engine_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  op_key text NOT NULL,
  fingerprint text NOT NULL,
  state text NOT NULL DEFAULT 'claimed' CHECK (state IN ('claimed','completed')),
  result jsonb,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT paper_engine_operations_user_op_uk UNIQUE (user_id, op_key)
);

CREATE INDEX paper_engine_operations_user_created_idx
  ON public.paper_engine_operations (user_id, created_at DESC);

-- Read-only for the owning user; NO insert/update/delete grants for authenticated.
GRANT SELECT ON public.paper_engine_operations TO authenticated;
GRANT ALL    ON public.paper_engine_operations TO service_role;

ALTER TABLE public.paper_engine_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own paper engine operations readable"
  ON public.paper_engine_operations
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Least-privilege claim: SECURITY DEFINER + strong (user_id, op_key) uniqueness.
CREATE OR REPLACE FUNCTION public.claim_paper_engine_operation(
  _user_id uuid,
  _op_key text,
  _fingerprint text
)
RETURNS TABLE(status text, result jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  IF v_row.fingerprint <> _fingerprint THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::jsonb;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'replayed'::text, v_row.result;
END;
$$;

-- Complete: only owner (or service_role) can transition claimed → completed.
CREATE OR REPLACE FUNCTION public.complete_paper_engine_operation(
  _user_id uuid,
  _op_key text,
  _result jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_jwt_role   text := current_setting('request.jwt.claim.role', true);
  v_pg_role    text := current_setting('role', true);
  v_claims     text := current_setting('request.jwt.claims', true);
  v_is_service boolean := false;
BEGIN
  IF _user_id IS NULL OR _op_key IS NULL THEN
    RAISE EXCEPTION 'user_id, op_key required';
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

  UPDATE public.paper_engine_operations
     SET state = 'completed',
         result = _result,
         completed_at = COALESCE(completed_at, now()),
         updated_at = now()
   WHERE user_id = _user_id
     AND op_key = _op_key
     AND state = 'claimed';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_paper_engine_operation(uuid, text, text)   FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_paper_engine_operation(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_paper_engine_operation(uuid, text, text)   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_paper_engine_operation(uuid, text, jsonb) TO authenticated, service_role;
