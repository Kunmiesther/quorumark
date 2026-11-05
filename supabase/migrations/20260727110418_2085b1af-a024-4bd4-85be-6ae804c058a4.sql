-- =========================================================================
-- live_fills — raw ApeX fills staging ledger
-- =========================================================================
CREATE TABLE public.live_fills (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES public.exchange_connections(id) ON DELETE RESTRICT,
  venue TEXT NOT NULL DEFAULT 'apex_omni',
  venue_fill_id TEXT NOT NULL,
  venue_order_id TEXT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  price NUMERIC(30,10) NOT NULL,
  size NUMERIC(30,10) NOT NULL CHECK (size > 0),
  fee NUMERIC(30,10) NOT NULL DEFAULT 0,
  fee_currency TEXT,
  liquidity TEXT,               -- MAKER / TAKER
  fill_ts TIMESTAMPTZ NOT NULL,
  residual_size NUMERIC(30,10) NOT NULL,   -- remaining unmatched qty on this fill
  matched_at TIMESTAMPTZ,                  -- non-null once residual_size = 0
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,  -- sanitized subset of venue fields
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX live_fills_conn_venue_fill_uidx
  ON public.live_fills(connection_id, venue_fill_id);
CREATE INDEX live_fills_matcher_idx
  ON public.live_fills(connection_id, symbol, fill_ts)
  WHERE residual_size > 0;
CREATE INDEX live_fills_user_conn_idx
  ON public.live_fills(user_id, connection_id, fill_ts DESC);

GRANT SELECT ON public.live_fills TO authenticated;
GRANT ALL ON public.live_fills TO service_role;
ALTER TABLE public.live_fills ENABLE ROW LEVEL SECURITY;
CREATE POLICY "live_fills owner read" ON public.live_fills
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- =========================================================================
-- live_fills_cursor — per-connection ingest cursor
-- =========================================================================
CREATE TABLE public.live_fills_cursor (
  connection_id UUID NOT NULL PRIMARY KEY REFERENCES public.exchange_connections(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_fill_id TEXT,
  last_fill_ts TIMESTAMPTZ,
  last_polled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX live_fills_cursor_user_idx ON public.live_fills_cursor(user_id);

GRANT SELECT ON public.live_fills_cursor TO authenticated;
GRANT ALL ON public.live_fills_cursor TO service_role;
ALTER TABLE public.live_fills_cursor ENABLE ROW LEVEL SECURITY;
CREATE POLICY "live_fills_cursor owner read" ON public.live_fills_cursor
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- =========================================================================
-- trades — add venue tracking fields for live fills
-- =========================================================================
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS book TEXT NOT NULL DEFAULT 'live'
    CHECK (book IN ('paper','live')),
  ADD COLUMN IF NOT EXISTS venue TEXT,
  ADD COLUMN IF NOT EXISTS venue_order_id TEXT,
  ADD COLUMN IF NOT EXISTS entry_venue_fill_id TEXT,
  ADD COLUMN IF NOT EXISTS exit_venue_fill_id TEXT,
  ADD COLUMN IF NOT EXISTS fees_usd NUMERIC(20,8) NOT NULL DEFAULT 0;

-- One trades row per (connection, exit fill id) — replay-safe.
CREATE UNIQUE INDEX IF NOT EXISTS trades_conn_exit_fill_uidx
  ON public.trades(connection_id, exit_venue_fill_id)
  WHERE exit_venue_fill_id IS NOT NULL;
