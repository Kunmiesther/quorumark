-- Multi-wallet management: add default/apex/assignment/error fields.
-- Additive only; existing rows preserved. All writes remain via service-role
-- edge functions; no new client-writable policies.

ALTER TABLE public.wallet_connections
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS apex_authorized boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS assigned_exchange_connection_id uuid NULL
    REFERENCES public.exchange_connections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_error text NULL,
  ADD COLUMN IF NOT EXISTS last_error_at timestamptz NULL;

-- At most one default per user.
CREATE UNIQUE INDEX IF NOT EXISTS wallet_connections_one_default_per_user
  ON public.wallet_connections (user_id)
  WHERE is_default;

-- Backfill: promote the currently-active wallet to default for each user
-- who does not yet have a default.
WITH picks AS (
  SELECT DISTINCT ON (user_id) id, user_id
  FROM public.wallet_connections
  WHERE is_active = true
    AND status NOT IN ('disconnected')
  ORDER BY user_id, verified_at DESC NULLS LAST, created_at DESC
)
UPDATE public.wallet_connections wc
   SET is_default = true
  FROM picks p
 WHERE wc.id = p.id
   AND NOT EXISTS (
     SELECT 1 FROM public.wallet_connections
      WHERE user_id = p.user_id AND is_default = true
   );

CREATE INDEX IF NOT EXISTS wallet_connections_assigned_exchange_idx
  ON public.wallet_connections (assigned_exchange_connection_id)
  WHERE assigned_exchange_connection_id IS NOT NULL;