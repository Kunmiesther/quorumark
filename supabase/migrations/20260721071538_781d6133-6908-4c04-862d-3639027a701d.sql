-- Extend paper_trades exit_reason to allow the deterministic
-- ONYX bank-profit close path (see src/lib/onyx/decide.ts:validateAiClose).
-- All other reasons unchanged. Mid-ladder DCA remains protected — the
-- Postgres check constraint only bounds the set of legal values; the
-- authority to close discretionarily lives in the paper engine.
ALTER TABLE public.paper_trades DROP CONSTRAINT IF EXISTS paper_trades_exit_reason_check;
ALTER TABLE public.paper_trades
  ADD CONSTRAINT paper_trades_exit_reason_check
  CHECK (exit_reason = ANY (ARRAY['tp_touch','stop','floor','scout_bos','bank_profit'])) NOT VALID;
