-- Regime router: each paper position remembers WHICH strategy (leg) opened it
-- and the regime at entry, so the engine can manage exits per-leg (Sniper ->
-- VWAP/zone, Hunter -> FVG targets, Accumulator -> pivot ladder) rather than
-- with one shared TP/stop model. Additive and back-compatible: existing rows
-- default to 'accumulator', the only leg that has traded so far.
ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS strategy text NOT NULL DEFAULT 'accumulator',
  ADD COLUMN IF NOT EXISTS regime_at_entry text;
