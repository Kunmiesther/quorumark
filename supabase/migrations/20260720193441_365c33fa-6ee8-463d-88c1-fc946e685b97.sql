ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS pending_rungs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS ladder_total_margin numeric,
  ADD COLUMN IF NOT EXISTS ladder_total_notional numeric,
  ADD COLUMN IF NOT EXISTS ladder_total_rungs integer;