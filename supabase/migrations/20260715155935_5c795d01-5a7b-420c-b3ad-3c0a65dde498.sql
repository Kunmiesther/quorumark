-- ApeX mainnet Phase B groundwork: durable order intent state machine.
--
-- This table is the single source of truth for every intended order from
-- preview → terminal state. It exists so that browser refreshes, worker
-- restarts, network timeouts, and duplicate clicks NEVER create a second
-- order: retries reuse the same client_order_id and reconcile against the
-- row already recorded here.
--
-- No secrets are stored here. Signing material lives only in the worker.

CREATE TYPE public.order_intent_state AS ENUM (
  'previewed',
  'confirmed',
  'queued',
  'signing',
  'submitted',
  'open',
  'partially_filled',
  'filled',
  'cancellation_pending',
  'cancelled',
  'rejected',
  'reconciliation_required',
  'failed'
);

CREATE TABLE public.order_intents (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES public.exchange_connections(id) ON DELETE CASCADE,
  client_order_id TEXT NOT NULL,
  wallet_address TEXT,
  environment TEXT NOT NULL CHECK (environment IN ('testnet','mainnet')),
  venue TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  order_type TEXT NOT NULL CHECK (order_type IN ('LIMIT','MARKET')),
  size NUMERIC NOT NULL CHECK (size > 0),
  protected_price NUMERIC,
  mark_price_at_preview NUMERIC,
  slippage_bps INTEGER,
  max_fee NUMERIC,
  expires_at TIMESTAMPTZ,
  reduce_only BOOLEAN NOT NULL DEFAULT false,
  state public.order_intent_state NOT NULL DEFAULT 'previewed',
  state_reason TEXT,
  exchange_order_id TEXT,
  exchange_status TEXT,
  filled_size NUMERIC NOT NULL DEFAULT 0,
  avg_fill_price NUMERIC,
  last_reconciled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_order_id)
);

CREATE INDEX order_intents_user_state_idx
  ON public.order_intents (user_id, state, created_at DESC);
CREATE INDEX order_intents_connection_idx
  ON public.order_intents (connection_id, created_at DESC);
CREATE INDEX order_intents_reconcile_idx
  ON public.order_intents (state, updated_at)
  WHERE state IN ('submitted','open','partially_filled','cancellation_pending','reconciliation_required');

GRANT SELECT ON public.order_intents TO authenticated;
GRANT ALL ON public.order_intents TO service_role;

ALTER TABLE public.order_intents ENABLE ROW LEVEL SECURITY;

-- Users may READ their own intents (dashboards / history / reconciliation UI).
-- Writes go only through server code (service_role via edge functions and the
-- Railway worker). No INSERT / UPDATE / DELETE policy for authenticated —
-- the client can never mutate order state directly.
CREATE POLICY "Users can view their own order intents"
  ON public.order_intents FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE TRIGGER update_order_intents_updated_at
  BEFORE UPDATE ON public.order_intents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();