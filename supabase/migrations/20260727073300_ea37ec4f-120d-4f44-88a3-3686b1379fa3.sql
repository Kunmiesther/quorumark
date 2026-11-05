
ALTER TABLE public.positions
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'live',
  ADD COLUMN IF NOT EXISTS venue_order_id text,
  ADD COLUMN IF NOT EXISTS unrealized_pnl numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS liquidation_price numeric,
  ADD COLUMN IF NOT EXISTS mark_price numeric,
  ADD COLUMN IF NOT EXISTS open_orders jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS synced_at timestamptz;

ALTER TABLE public.positions
  DROP CONSTRAINT IF EXISTS positions_source_check;
ALTER TABLE public.positions
  ADD CONSTRAINT positions_source_check CHECK (source IN ('live','paper'));

-- One OPEN live row per (user, connection, symbol, side) so the reconciler
-- can idempotently upsert. Closed rows are unconstrained (historical).
CREATE UNIQUE INDEX IF NOT EXISTS positions_live_open_unique
  ON public.positions (user_id, connection_id, pair, side)
  WHERE status = 'open' AND source = 'live';

CREATE INDEX IF NOT EXISTS positions_user_source_status_idx
  ON public.positions (user_id, source, status);
