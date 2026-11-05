
-- =========================================================
-- Scout Intelligence Foundation — Stage 1 (data layer)
-- Additive only. Preserves existing scout_* tables and policies.
-- =========================================================

-- ---- 1. Extend scout_evidence (nullable additions only) ----
ALTER TABLE public.scout_evidence
  ADD COLUMN IF NOT EXISTS scan_id UUID,
  ADD COLUMN IF NOT EXISTS symbol TEXT,
  ADD COLUMN IF NOT EXISTS direction TEXT,
  ADD COLUMN IF NOT EXISTS weighted_score NUMERIC,
  ADD COLUMN IF NOT EXISTS evidence JSONB,
  ADD COLUMN IF NOT EXISTS candle_count INTEGER,
  ADD COLUMN IF NOT EXISTS last_closed_ts_ms BIGINT,
  ADD COLUMN IF NOT EXISTS age_ms BIGINT,
  ADD COLUMN IF NOT EXISTS fresh BOOLEAN,
  ADD COLUMN IF NOT EXISTS missing_fields TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS evidence_schema_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS rules_version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS scout_evidence_user_symbol_created_idx
  ON public.scout_evidence (user_id, symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS scout_evidence_scan_idx
  ON public.scout_evidence (user_id, scan_id);

-- ---- 2. Extend scout_outcomes (nullable additions only) ----
ALTER TABLE public.scout_outcomes
  ADD COLUMN IF NOT EXISTS evidence_id UUID REFERENCES public.scout_evidence(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS window_key TEXT,
  ADD COLUMN IF NOT EXISTS net_pct NUMERIC,
  ADD COLUMN IF NOT EXISTS target_hit BOOLEAN,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS bars_used INTEGER,
  ADD COLUMN IF NOT EXISTS reason_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS supersedes_id UUID REFERENCES public.scout_outcomes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS outcome_schema_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS rules_version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS scout_outcomes_user_signal_idx
  ON public.scout_outcomes (user_id, signal_id);
CREATE INDEX IF NOT EXISTS scout_outcomes_status_idx
  ON public.scout_outcomes (user_id, status);

-- ---- 3. scout_signal_state (current per user+symbol) ----
CREATE TABLE IF NOT EXISTS public.scout_signal_state (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  state TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'none',
  weighted_score NUMERIC NOT NULL DEFAULT 0,
  aligned_streak INTEGER NOT NULL DEFAULT 0,
  entered_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  last_scan_id UUID,
  prior_state TEXT,
  reason_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  state_schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.scout_signal_state TO authenticated;
GRANT ALL ON public.scout_signal_state TO service_role;
ALTER TABLE public.scout_signal_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "scout_signal_state owner select" ON public.scout_signal_state;
CREATE POLICY "scout_signal_state owner select" ON public.scout_signal_state
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "scout_signal_state owner insert" ON public.scout_signal_state;
CREATE POLICY "scout_signal_state owner insert" ON public.scout_signal_state
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "scout_signal_state owner update" ON public.scout_signal_state;
CREATE POLICY "scout_signal_state owner update" ON public.scout_signal_state
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "scout_signal_state owner delete" ON public.scout_signal_state;
CREATE POLICY "scout_signal_state owner delete" ON public.scout_signal_state
  FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS scout_signal_state_user_symbol_idx
  ON public.scout_signal_state (user_id, symbol);

DROP TRIGGER IF EXISTS scout_signal_state_updated_at ON public.scout_signal_state;
CREATE TRIGGER scout_signal_state_updated_at
  BEFORE UPDATE ON public.scout_signal_state
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---- 4. scout_state_transitions (append-only) ----
CREATE TABLE IF NOT EXISTS public.scout_state_transitions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  scan_id UUID,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'none',
  weighted_score NUMERIC NOT NULL DEFAULT 0,
  reason_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  state_schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol, scan_id)
);
GRANT SELECT, INSERT ON public.scout_state_transitions TO authenticated;
GRANT ALL ON public.scout_state_transitions TO service_role;
ALTER TABLE public.scout_state_transitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "scout_state_transitions owner select" ON public.scout_state_transitions;
CREATE POLICY "scout_state_transitions owner select" ON public.scout_state_transitions
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "scout_state_transitions owner insert" ON public.scout_state_transitions;
CREATE POLICY "scout_state_transitions owner insert" ON public.scout_state_transitions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS scout_state_transitions_user_symbol_created_idx
  ON public.scout_state_transitions (user_id, symbol, created_at DESC);

-- Enforce append-only: block UPDATE/DELETE via trigger.
CREATE OR REPLACE FUNCTION public.scout_state_transitions_block_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'scout_state_transitions is append-only; % not permitted', TG_OP;
END; $$;

DROP TRIGGER IF EXISTS scout_state_transitions_no_update ON public.scout_state_transitions;
CREATE TRIGGER scout_state_transitions_no_update
  BEFORE UPDATE OR DELETE ON public.scout_state_transitions
  FOR EACH ROW EXECUTE FUNCTION public.scout_state_transitions_block_mutation();

-- ---- 5. scout_rule_proposals ----
CREATE TABLE IF NOT EXISTS public.scout_rule_proposals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  proposal_key TEXT NOT NULL,
  before_rules JSONB NOT NULL DEFAULT '{}'::JSONB,
  after_rules JSONB NOT NULL DEFAULT '{}'::JSONB,
  backtest_summary JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','approved','rejected')),
  created_by UUID,
  reviewed_by UUID,
  reviewed_at TIMESTAMP WITH TIME ZONE,
  rules_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.scout_rule_proposals TO authenticated;
GRANT ALL ON public.scout_rule_proposals TO service_role;
ALTER TABLE public.scout_rule_proposals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "scout_rule_proposals owner select" ON public.scout_rule_proposals;
CREATE POLICY "scout_rule_proposals owner select" ON public.scout_rule_proposals
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "scout_rule_proposals owner insert" ON public.scout_rule_proposals;
CREATE POLICY "scout_rule_proposals owner insert" ON public.scout_rule_proposals
  FOR INSERT WITH CHECK (auth.uid() = user_id AND status = 'proposed');

CREATE INDEX IF NOT EXISTS scout_rule_proposals_user_status_idx
  ON public.scout_rule_proposals (user_id, status);

DROP TRIGGER IF EXISTS scout_rule_proposals_updated_at ON public.scout_rule_proposals;
CREATE TRIGGER scout_rule_proposals_updated_at
  BEFORE UPDATE ON public.scout_rule_proposals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---- 6. Retention helper (NOT scheduled) ----
CREATE OR REPLACE FUNCTION public.scout_retention_purge(_days INTEGER DEFAULT 60)
RETURNS TABLE (evidence_deleted BIGINT, transitions_deleted BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ev_del BIGINT;
  v_tr_del BIGINT;
  v_cutoff TIMESTAMPTZ := now() - make_interval(days => GREATEST(_days, 1));
BEGIN
  WITH d AS (
    DELETE FROM public.scout_evidence WHERE created_at < v_cutoff RETURNING 1
  ) SELECT count(*) INTO v_ev_del FROM d;
  WITH d AS (
    DELETE FROM public.scout_state_transitions WHERE created_at < v_cutoff RETURNING 1
  ) SELECT count(*) INTO v_tr_del FROM d;
  evidence_deleted := v_ev_del;
  transitions_deleted := v_tr_del;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.scout_retention_purge(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.scout_retention_purge(INTEGER) TO service_role;
