ALTER TABLE public.paper_trades DROP CONSTRAINT IF EXISTS paper_trades_exit_reason_check;
ALTER TABLE public.paper_trades ADD CONSTRAINT paper_trades_exit_reason_check
  CHECK (exit_reason = ANY (ARRAY['tp_touch','stop','floor','max_loss','onyx_cut','counter_trend']));