CREATE TABLE IF NOT EXISTS public.live_recon_leases (
  connection_id uuid PRIMARY KEY,
  lease_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.live_recon_leases TO service_role;

ALTER TABLE public.live_recon_leases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role only" ON public.live_recon_leases
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.claim_live_recon_lease(_connection_id uuid, _ttl_secs integer DEFAULT 90)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _now timestamptz := now();
  _claimed boolean := false;
BEGIN
  INSERT INTO public.live_recon_leases (connection_id, lease_until, updated_at)
  VALUES (_connection_id, _now + make_interval(secs => _ttl_secs), _now)
  ON CONFLICT (connection_id) DO UPDATE
    SET lease_until = _now + make_interval(secs => _ttl_secs),
        updated_at = _now
    WHERE public.live_recon_leases.lease_until < _now
  RETURNING true INTO _claimed;

  RETURN COALESCE(_claimed, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_live_recon_lease(_connection_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.live_recon_leases
     SET lease_until = now() - interval '1 second', updated_at = now()
   WHERE connection_id = _connection_id;
$$;