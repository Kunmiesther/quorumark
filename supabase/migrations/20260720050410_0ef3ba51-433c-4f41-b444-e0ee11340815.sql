ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS trend_at_entry text,
  ADD COLUMN IF NOT EXISTS trend_slope_pct_at_entry numeric;