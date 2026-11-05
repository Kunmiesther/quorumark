
-- Allow authenticated owners to insert/update their own apex_execution_credentials
-- rows via the signer, which now acts on behalf of the caller instead of using
-- service-role. Deletes remain blocked; revocation is via UPDATE (active=false,
-- revoked_at=now()).

-- Drop the block-all client-write policies on apex_execution_credentials.
DROP POLICY IF EXISTS "No client inserts on apex execution credentials" ON public.apex_execution_credentials;
DROP POLICY IF EXISTS "No client updates on apex execution credentials" ON public.apex_execution_credentials;

-- Owner-scoped writes.
CREATE POLICY "Owners can insert their apex execution credentials"
  ON public.apex_execution_credentials FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Owners can update their apex execution credentials"
  ON public.apex_execution_credentials FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Grants (PostgREST needs these in addition to RLS).
GRANT SELECT, INSERT, UPDATE ON public.apex_execution_credentials TO authenticated;
GRANT ALL ON public.apex_execution_credentials TO service_role;

-- Audit inserts by owners (event/detail metadata only; no crypto material).
CREATE POLICY "Owners can insert their credential audit"
  ON public.apex_credential_audit FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

GRANT SELECT, INSERT ON public.apex_credential_audit TO authenticated;
GRANT ALL ON public.apex_credential_audit TO service_role;
