ALTER TABLE public.ai_committee_evaluations
  ADD COLUMN IF NOT EXISTS risk_dissent boolean NOT NULL DEFAULT false;

DROP POLICY IF EXISTS "Users insert their own committee evaluations" ON public.ai_committee_evaluations;

REVOKE INSERT, UPDATE, DELETE ON public.ai_committee_evaluations FROM authenticated;
GRANT SELECT ON public.ai_committee_evaluations TO authenticated;
GRANT ALL ON public.ai_committee_evaluations TO service_role;