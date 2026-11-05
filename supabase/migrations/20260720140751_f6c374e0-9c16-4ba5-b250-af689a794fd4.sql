
ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS rung_count integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS first_fill_vwap numeric,
  ADD COLUMN IF NOT EXISTS resize_levels jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS fills jsonb NOT NULL DEFAULT '[]'::jsonb;
