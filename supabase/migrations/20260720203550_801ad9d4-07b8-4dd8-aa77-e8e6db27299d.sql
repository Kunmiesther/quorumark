
ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS structure_broken boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS structure_broken_ts_ms bigint,
  ADD COLUMN IF NOT EXISTS structure_broken_level numeric,
  ADD COLUMN IF NOT EXISTS protective_swing_level numeric,
  ADD COLUMN IF NOT EXISTS protective_swing_kind text;
