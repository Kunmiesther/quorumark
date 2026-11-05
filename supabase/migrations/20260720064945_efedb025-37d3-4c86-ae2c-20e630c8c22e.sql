ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS strategy text NOT NULL DEFAULT 'accumulator',
  ADD COLUMN IF NOT EXISTS regime_at_entry text;