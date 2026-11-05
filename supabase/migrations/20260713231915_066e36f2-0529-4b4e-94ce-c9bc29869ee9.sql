-- Phase 1 safety: mark non-allowlisted exchange connections as unsupported.
-- Allowlist: btcc, bydfi only.

ALTER TYPE public.connection_status ADD VALUE IF NOT EXISTS 'unsupported';

-- Commit enum add before using new value.
COMMIT;
BEGIN;

UPDATE public.exchange_connections
SET status = 'unsupported'::public.connection_status,
    last_error = COALESCE(last_error, 'Exchange no longer supported (allowlist: btcc, bydfi).'),
    updated_at = now()
WHERE lower(exchange) NOT IN ('btcc', 'bydfi');