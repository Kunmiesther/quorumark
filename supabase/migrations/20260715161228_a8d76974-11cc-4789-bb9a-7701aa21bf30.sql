
-- === apex_onboarding_challenges ================================================
CREATE TABLE public.apex_onboarding_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wallet_address text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('mainnet','testnet')),
  purpose text NOT NULL CHECK (purpose = 'apex_omni_onboarding'),
  nonce_hash text NOT NULL UNIQUE,
  challenge_text text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX apex_onboarding_challenges_user_idx
  ON public.apex_onboarding_challenges (user_id, environment);

GRANT SELECT, INSERT ON public.apex_onboarding_challenges TO authenticated;
GRANT ALL ON public.apex_onboarding_challenges TO service_role;
ALTER TABLE public.apex_onboarding_challenges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user reads own onboarding challenges"
  ON public.apex_onboarding_challenges FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "user creates own onboarding challenges"
  ON public.apex_onboarding_challenges FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND consumed_at IS NULL);

-- === apex_execution_credentials ================================================
CREATE TABLE public.apex_execution_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange_connection_id uuid NOT NULL REFERENCES public.exchange_connections(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('mainnet','testnet')),
  wallet_address text NOT NULL,
  apex_account_id text,
  encrypted_credentials text NOT NULL,
  encryption_key_version int NOT NULL DEFAULT 1,
  credential_fingerprint text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  last_verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One active bundle per (user, wallet, connection, environment)
CREATE UNIQUE INDEX apex_execution_credentials_one_active
  ON public.apex_execution_credentials (user_id, wallet_address, exchange_connection_id, environment)
  WHERE active = true AND revoked_at IS NULL;

-- Service-role only. Users NEVER select from this table directly.
GRANT ALL ON public.apex_execution_credentials TO service_role;
ALTER TABLE public.apex_execution_credentials ENABLE ROW LEVEL SECURITY;
-- No policies for authenticated => authenticated cannot read/write anything.

CREATE TRIGGER apex_execution_credentials_updated_at
  BEFORE UPDATE ON public.apex_execution_credentials
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- === Sanitized status view (safe for UI) =======================================
CREATE OR REPLACE VIEW public.apex_execution_credentials_status
WITH (security_invoker = true) AS
SELECT
  id,
  user_id,
  exchange_connection_id,
  environment,
  wallet_address,
  apex_account_id,
  encryption_key_version,
  credential_fingerprint,
  active,
  created_at,
  rotated_at,
  revoked_at,
  last_verified_at
FROM public.apex_execution_credentials
WHERE user_id = auth.uid();

GRANT SELECT ON public.apex_execution_credentials_status TO authenticated;

-- === apex_credential_audit (append-only) =======================================
CREATE TABLE public.apex_credential_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id uuid REFERENCES public.apex_execution_credentials(id) ON DELETE SET NULL,
  user_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('created','verified','rotated','used','revoked','signing_failed')),
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.apex_credential_audit TO authenticated;
GRANT ALL ON public.apex_credential_audit TO service_role;
ALTER TABLE public.apex_credential_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user reads own credential audit"
  ON public.apex_credential_audit FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.apex_credential_audit_block_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'apex_credential_audit is append-only; % is not permitted', TG_OP;
END;
$$;
CREATE TRIGGER apex_credential_audit_no_update BEFORE UPDATE ON public.apex_credential_audit
  FOR EACH ROW EXECUTE FUNCTION public.apex_credential_audit_block_mutation();
CREATE TRIGGER apex_credential_audit_no_delete BEFORE DELETE ON public.apex_credential_audit
  FOR EACH ROW EXECUTE FUNCTION public.apex_credential_audit_block_mutation();
