DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'paper_trades'
      AND c.conname = 'paper_trades_exit_reason_check'
  ) THEN
    ALTER TABLE public.paper_trades DROP CONSTRAINT paper_trades_exit_reason_check;
  END IF;
END $$;

ALTER TABLE public.paper_trades
  ADD CONSTRAINT paper_trades_exit_reason_check
  CHECK (exit_reason = ANY (ARRAY['tp_touch','stop','floor','scout_bos'])) NOT VALID;