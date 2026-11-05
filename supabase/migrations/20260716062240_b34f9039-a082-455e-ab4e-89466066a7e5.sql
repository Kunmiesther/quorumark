-- Correct dca (Accumulator) strategy market to 'futures' to match ratified spec at docs/STRATEGY_SPEC_v1.md.
-- Idempotent single-row data correction; no schema, RLS, grants, or other rows affected.
UPDATE public.strategies SET markets = 'futures' WHERE slug = 'dca';