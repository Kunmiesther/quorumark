ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS strategy_metadata jsonb,
  ADD COLUMN IF NOT EXISTS tp_tiers jsonb;

ALTER TABLE public.positions
  ADD COLUMN IF NOT EXISTS strategy_metadata jsonb,
  ADD COLUMN IF NOT EXISTS tp_tiers jsonb;

COMMENT ON COLUMN public.paper_positions.strategy_metadata IS 'Per-strategy state bag (JSONB). For H2 sweep: { h2: true, ladder_id, entry_bar_ts_1h, first_fill_ts, rungs: [{index, price, marginUsd, weight, qty, depthFrac, filled_at?}] }';
COMMENT ON COLUMN public.paper_positions.tp_tiers IS 'H2 tier plan (JSONB). [{index, label, frac, rr, price, qty, filled_at?}]';
COMMENT ON COLUMN public.positions.strategy_metadata IS 'Mirror of paper_positions.strategy_metadata for the live path.';
COMMENT ON COLUMN public.positions.tp_tiers IS 'Mirror of paper_positions.tp_tiers for the live path.';