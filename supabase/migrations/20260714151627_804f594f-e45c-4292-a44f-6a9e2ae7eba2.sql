
CREATE TABLE public.proof_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token text NOT NULL UNIQUE,
  symbol text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  consumed_by_idempotency_key text
);

GRANT SELECT ON public.proof_authorizations TO authenticated;
GRANT ALL ON public.proof_authorizations TO service_role;

ALTER TABLE public.proof_authorizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own proof tokens"
  ON public.proof_authorizations
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());
