ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS strategy_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.positions
  ADD COLUMN IF NOT EXISTS strategy_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS paper_positions_strategy_metadata_gin
  ON public.paper_positions USING GIN (strategy_metadata);

CREATE INDEX IF NOT EXISTS positions_strategy_metadata_gin
  ON public.positions USING GIN (strategy_metadata);

COMMENT ON COLUMN public.paper_positions.strategy_metadata IS
  'Per-leg lifecycle state (H2 sweep ladder rungs, tier arm status, avg entry recompute, etc.). Shape is leg-specific; parity-locked between paper and live.';
COMMENT ON COLUMN public.positions.strategy_metadata IS
  'Per-leg lifecycle state (H2 sweep ladder rungs, tier arm status, avg entry recompute, etc.). Shape is leg-specific; parity-locked between paper and live.';