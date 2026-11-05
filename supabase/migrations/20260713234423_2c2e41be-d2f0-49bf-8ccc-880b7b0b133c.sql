-- 1. Extend connection_status enum
ALTER TYPE public.connection_status ADD VALUE IF NOT EXISTS 'pending_verification';

-- 2. Additive columns on exchange_connections
ALTER TABLE public.exchange_connections
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'test',
  ADD COLUMN IF NOT EXISTS permissions_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_health_check_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error_code text,
  ADD COLUMN IF NOT EXISTS last_error_message text;

-- 3. Backfill last_error_message from legacy last_error
UPDATE public.exchange_connections
SET last_error_message = last_error
WHERE last_error IS NOT NULL AND last_error_message IS NULL;

-- 4. Drop plaintext credential columns (only contained worthless base64)
ALTER TABLE public.exchange_connections
  DROP COLUMN IF EXISTS api_key_encrypted,
  DROP COLUMN IF EXISTS api_secret_encrypted;

-- 5. Partial unique index: at most one active connection per (user_id, exchange)
DROP INDEX IF EXISTS public.exchange_connections_one_active_per_exchange;
CREATE UNIQUE INDEX exchange_connections_one_active_per_exchange
  ON public.exchange_connections (user_id, exchange)
  WHERE status NOT IN ('unsupported', 'disconnected');

-- 6. New credentials table (service-role only)
CREATE TABLE IF NOT EXISTS public.exchange_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.exchange_connections(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  encrypted_api_key text NOT NULL,
  encrypted_api_secret text NOT NULL,
  encrypted_passphrase text,
  encryption_version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  UNIQUE (connection_id)
);

-- 7. Grants — NO grants to anon or authenticated. Service role only.
REVOKE ALL ON public.exchange_credentials FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.exchange_credentials TO service_role;

-- 8. Enable RLS with zero policies for authenticated. Service role bypasses RLS.
ALTER TABLE public.exchange_credentials ENABLE ROW LEVEL SECURITY;
-- (intentionally no CREATE POLICY statements)

-- 9. Tighten exchange_connections RLS: users may only SELECT their own rows.
--    Credential/connection writes must go through the edge function (service role).
DROP POLICY IF EXISTS "Users insert own connections" ON public.exchange_connections;
DROP POLICY IF EXISTS "Users update own connections" ON public.exchange_connections;
DROP POLICY IF EXISTS "Users delete own connections" ON public.exchange_connections;
-- SELECT policy "Users view own connections" is preserved.