ALTER TABLE public.paper_ai_orchestrations
  ADD COLUMN IF NOT EXISTS snapshot_valid boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS snapshot_invalid_code text,
  ADD COLUMN IF NOT EXISTS snapshot_detail jsonb,
  ADD COLUMN IF NOT EXISTS record_kind text NOT NULL DEFAULT 'runtime',
  ADD COLUMN IF NOT EXISTS corrected_at timestamptz,
  ADD COLUMN IF NOT EXISTS correction_reason text;

ALTER TABLE public.paper_ai_orchestrations
  DROP CONSTRAINT IF EXISTS paper_ai_orchestrations_terminal_outcome_check;
ALTER TABLE public.paper_ai_orchestrations
  ADD CONSTRAINT paper_ai_orchestrations_terminal_outcome_check
  CHECK (terminal_outcome = ANY (ARRAY['TRADE_CANDIDATE','NO_TRADE_STRATEGY','NO_TRADE_RISK','NO_TRADE_DATA','PIPELINE_ERROR']));

ALTER TABLE public.paper_ai_orchestrations
  DROP CONSTRAINT IF EXISTS paper_ai_orchestrations_record_kind_check;
ALTER TABLE public.paper_ai_orchestrations
  ADD CONSTRAINT paper_ai_orchestrations_record_kind_check
  CHECK (record_kind = ANY (ARRAY['runtime','replay','backfill']));

-- Hard invariant: an invalid market snapshot can never authorise a trade.
ALTER TABLE public.paper_ai_orchestrations
  DROP CONSTRAINT IF EXISTS paper_ai_orchestrations_invalid_snapshot_never_allows;
ALTER TABLE public.paper_ai_orchestrations
  ADD CONSTRAINT paper_ai_orchestrations_invalid_snapshot_never_allows
  CHECK (snapshot_valid OR (gate_allowed = false AND COALESCE(risk_passed, false) = false));

CREATE INDEX IF NOT EXISTS paper_ai_orchestrations_record_kind_idx
  ON public.paper_ai_orchestrations (record_kind, created_at DESC);