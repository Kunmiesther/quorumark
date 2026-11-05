ALTER TABLE public.exchange_connections
  ADD COLUMN IF NOT EXISTS permission_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS permission_scopes jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS permission_trade boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS permissions_verified boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS exchange_connections_permission_verified_at_idx
  ON public.exchange_connections (permission_verified_at);

COMMENT ON COLUMN public.exchange_connections.permission_verified_at IS
  'Timestamp of the last successful signer VERIFY_CREDENTIALS + READ_ACCOUNT call. Mainnet order gates require this to be within 24h.';
COMMENT ON COLUMN public.exchange_connections.permission_scopes IS
  'JSON snapshot of scopes/permissions returned by the venue at the last verification (e.g. {"read": true, "trade": true, "withdraw": false}).';
COMMENT ON COLUMN public.exchange_connections.permission_trade IS
  'True only when the venue reports the credential has trade permission. Order path requires true.';
COMMENT ON COLUMN public.exchange_connections.permissions_verified IS
  'Convenience boolean: true when permission_verified_at is set and non-null in the most recent verification.';
