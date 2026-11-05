ALTER TABLE public.strategy_decisions
  ADD COLUMN IF NOT EXISTS trace_id uuid,
  ADD COLUMN IF NOT EXISTS terminal_outcome text,
  ADD COLUMN IF NOT EXISTS terminal_reason text,
  ADD COLUMN IF NOT EXISTS terminal_at timestamptz,
  ADD COLUMN IF NOT EXISTS risk_check jsonb,
  ADD COLUMN IF NOT EXISTS simulated_intent jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'strategy_decisions_terminal_outcome_check'
  ) THEN
    ALTER TABLE public.strategy_decisions
      ADD CONSTRAINT strategy_decisions_terminal_outcome_check
      CHECK (terminal_outcome IS NULL OR terminal_outcome IN
        ('TRADE_CANDIDATE','NO_TRADE_STRATEGY','NO_TRADE_RISK','PIPELINE_ERROR'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS strategy_decisions_terminal_idx
  ON public.strategy_decisions (terminal_at DESC);