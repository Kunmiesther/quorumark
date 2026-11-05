ALTER TABLE public.committee_shortlist
  ADD COLUMN IF NOT EXISTS entry_plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS risk_objection jsonb NOT NULL DEFAULT '{}'::jsonb;