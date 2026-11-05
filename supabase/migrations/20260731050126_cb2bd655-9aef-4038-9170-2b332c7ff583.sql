CREATE TABLE public.strategy_candidates (
  candidate_id text PRIMARY KEY,
  user_id uuid NOT NULL,
  connection_id uuid,
  strategy text NOT NULL,
  symbol text NOT NULL,
  timeframe text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('long','short')),
  candle_close_at timestamptz NOT NULL,
  market_data_at timestamptz,
  freshness_ms integer,
  entry_zone jsonb,
  invalidation numeric,
  tp_ladder jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_hash text NOT NULL,
  schema_version text NOT NULL DEFAULT 'candidate.v1',
  technical_decision text NOT NULL DEFAULT 'technical_validated'
    CHECK (technical_decision IN ('technical_validated','technical_rejected')),
  technical_reason text,
  idempotency_key text,
  ai_shadow_state text NOT NULL DEFAULT 'ai_shadow_pending'
    CHECK (ai_shadow_state IN ('ai_shadow_pending','ai_shadow_evaluated','ai_shadow_unavailable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX strategy_candidates_user_symbol_idx
  ON public.strategy_candidates (user_id, symbol, candle_close_at DESC);
CREATE INDEX strategy_candidates_evidence_hash_idx
  ON public.strategy_candidates (evidence_hash);
CREATE INDEX strategy_candidates_idem_idx
  ON public.strategy_candidates (idempotency_key);

GRANT SELECT ON public.strategy_candidates TO authenticated;
GRANT ALL ON public.strategy_candidates TO service_role;

ALTER TABLE public.strategy_candidates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners read their own candidates"
  ON public.strategy_candidates FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE TRIGGER strategy_candidates_touch
  BEFORE UPDATE ON public.strategy_candidates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();