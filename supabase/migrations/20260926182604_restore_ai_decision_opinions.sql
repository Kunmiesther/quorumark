-- Repair schema drift: the deployed decision evaluator already uses this table.
-- Version matches the verified production migration ledger.
-- Evidence storage only. No strategy, live permission, or position changes.
CREATE TABLE IF NOT EXISTS public.ai_decision_opinions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id text NOT NULL REFERENCES public.strategy_decisions(decision_id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('lead', 'risk', 'structure')),
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('evaluated', 'unavailable')),
  direction text CHECK (direction IS NULL OR direction IN ('long', 'short', 'wait')),
  confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  summary text,
  risk_flags text[] NOT NULL DEFAULT '{}',
  latency_ms integer,
  prompt_version text NOT NULL,
  evidence_hash text NOT NULL,
  unavailable_reason text,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  advisory boolean NOT NULL DEFAULT true,
  CONSTRAINT ai_decision_opinions_advisory_only CHECK (advisory IS TRUE),
  CONSTRAINT ai_decision_opinions_unique UNIQUE (decision_id, role, evidence_hash),
  CONSTRAINT ai_decision_opinions_status_shape CHECK (
    (status = 'evaluated' AND direction IS NOT NULL)
    OR (status = 'unavailable' AND direction IS NULL AND confidence IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS ai_decision_opinions_user_idx
  ON public.ai_decision_opinions (user_id);

ALTER TABLE public.ai_decision_opinions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_decision_opinions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ai_decision_opinions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_decision_opinions TO service_role;

DROP POLICY IF EXISTS "Owners read their own decision opinions" ON public.ai_decision_opinions;
CREATE POLICY "Owners read their own decision opinions"
  ON public.ai_decision_opinions FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

NOTIFY pgrst, 'reload schema';
