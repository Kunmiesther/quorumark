CREATE TABLE IF NOT EXISTS public.paper_order_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  run_id TEXT NULL,
  epoch_id UUID NULL REFERENCES public.paper_epochs(id) ON DELETE SET NULL,
  scan_id UUID NULL REFERENCES public.scout_scans(id) ON DELETE SET NULL,
  ranking_snapshot_id UUID NULL REFERENCES public.scout_universe_snapshots(id) ON DELETE SET NULL,
  onyx_decision_id UUID NULL REFERENCES public.onyx_decisions(id) ON DELETE SET NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long','short')),
  strategy TEXT NULL,
  state TEXT NOT NULL CHECK (state IN ('approved','wait','rejected','executed','failed')),
  reason_code TEXT NOT NULL,
  reason_detail TEXT NOT NULL DEFAULT '',
  margin NUMERIC NOT NULL DEFAULT 0,
  notional NUMERIC NOT NULL DEFAULT 0,
  leverage NUMERIC NOT NULL DEFAULT 0,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.paper_order_intents TO authenticated;
GRANT ALL ON public.paper_order_intents TO service_role;

ALTER TABLE public.paper_order_intents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own paper intents" ON public.paper_order_intents;
CREATE POLICY "Users can view own paper intents"
  ON public.paper_order_intents
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create own paper intents" ON public.paper_order_intents;
CREATE POLICY "Users can create own paper intents"
  ON public.paper_order_intents
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own paper intents" ON public.paper_order_intents;
CREATE POLICY "Users can update own paper intents"
  ON public.paper_order_intents
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_paper_order_intents_user_created
  ON public.paper_order_intents (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_order_intents_user_state
  ON public.paper_order_intents (user_id, state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_order_intents_snapshot
  ON public.paper_order_intents (ranking_snapshot_id, symbol, side);

DROP TRIGGER IF EXISTS update_paper_order_intents_updated_at ON public.paper_order_intents;
CREATE TRIGGER update_paper_order_intents_updated_at
  BEFORE UPDATE ON public.paper_order_intents
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();