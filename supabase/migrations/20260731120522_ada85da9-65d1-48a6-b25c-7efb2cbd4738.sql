-- Versioning + deterministic shadow score on the advisory ledger
ALTER TABLE public.ai_committee_evaluations
  ADD COLUMN IF NOT EXISTS prompt_version text NOT NULL DEFAULT 'prompt.v1',
  ADD COLUMN IF NOT EXISTS scorer_version text NOT NULL DEFAULT 'scorer.v1',
  ADD COLUMN IF NOT EXISTS shadow_score numeric,
  ADD COLUMN IF NOT EXISTS score_band text;

ALTER TABLE public.ai_committee_evaluations
  DROP CONSTRAINT IF EXISTS ai_committee_score_band_ck;
ALTER TABLE public.ai_committee_evaluations
  ADD CONSTRAINT ai_committee_score_band_ck
  CHECK (score_band IS NULL OR score_band = ANY (ARRAY['strong','moderate','weak','avoid','insufficient']));

-- Completed-trade outcomes linked to the canonical candidate identity.
CREATE TABLE IF NOT EXISTS public.candidate_outcomes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL DEFAULT auth.uid(),
  candidate_id text NOT NULL,
  symbol text NOT NULL,
  strategy text NOT NULL,
  direction text NOT NULL CHECK (direction = ANY (ARRAY['long','short'])),
  source text NOT NULL CHECK (source = ANY (ARRAY['paper','live'])),
  status text NOT NULL DEFAULT 'open' CHECK (status = ANY (ARRAY['open','closed','cancelled'])),
  opened_at timestamp with time zone,
  closed_at timestamp with time zone,
  entry_price numeric,
  exit_price numeric,
  realized_pnl_usd numeric,
  r_multiple numeric,
  outcome text CHECK (outcome IS NULL OR outcome = ANY (ARRAY['win','loss','scratch'])),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT candidate_outcomes_unique UNIQUE (user_id, candidate_id, source)
);

CREATE INDEX IF NOT EXISTS candidate_outcomes_lookup_idx
  ON public.candidate_outcomes (user_id, status, closed_at DESC);

GRANT SELECT ON public.candidate_outcomes TO authenticated;
GRANT ALL ON public.candidate_outcomes TO service_role;

ALTER TABLE public.candidate_outcomes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read their own candidate outcomes" ON public.candidate_outcomes;
CREATE POLICY "Users read their own candidate outcomes"
  ON public.candidate_outcomes FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);