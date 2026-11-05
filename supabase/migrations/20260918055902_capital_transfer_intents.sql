-- Durable idempotency ledger for same-account ApeX Funding <-> Perps moves.
-- External addresses and chains are intentionally absent from this schema.
CREATE TABLE IF NOT EXISTS public.capital_transfer_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange_connection_id uuid NOT NULL REFERENCES public.exchange_connections(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('move_to_perps', 'return_to_funding')),
  asset text NOT NULL DEFAULT 'USDT' CHECK (asset = 'USDT'),
  amount numeric(38, 8) NOT NULL CHECK (amount > 0),
  status text NOT NULL CHECK (status IN ('pending', 'submitted', 'uncertain')),
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (user_id, request_id)
);

CREATE INDEX IF NOT EXISTS capital_transfer_intents_connection_created_idx
  ON public.capital_transfer_intents (exchange_connection_id, created_at DESC);

ALTER TABLE public.capital_transfer_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.capital_transfer_intents FROM anon, authenticated;
GRANT ALL ON TABLE public.capital_transfer_intents TO service_role;

COMMENT ON TABLE public.capital_transfer_intents IS
  'Server-only idempotency ledger for internal ApeX Funding and Perps allocations.';
