CREATE TABLE IF NOT EXISTS public.scout_rotation_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  exchange TEXT NOT NULL,
  environment public.scout_environment NOT NULL,
  market_type public.scout_market_type NOT NULL,
  last_cursor INTEGER NOT NULL DEFAULT 0 CHECK (last_cursor >= 0),
  discovered_count INTEGER NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
  eligible_count INTEGER NOT NULL DEFAULT 0 CHECK (eligible_count >= 0),
  scanned_this_cycle INTEGER NOT NULL DEFAULT 0 CHECK (scanned_this_cycle >= 0),
  fresh_covered_count INTEGER NOT NULL DEFAULT 0 CHECK (fresh_covered_count >= 0),
  rejected_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  ranked_count INTEGER NOT NULL DEFAULT 0 CHECK (ranked_count >= 0),
  next_rotation INTEGER NOT NULL DEFAULT 0 CHECK (next_rotation >= 0),
  last_snapshot_id UUID NULL REFERENCES public.scout_universe_snapshots(id) ON DELETE SET NULL,
  last_scan_id UUID NULL REFERENCES public.scout_scans(id) ON DELETE SET NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, exchange, environment, market_type)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.scout_rotation_state TO authenticated;
GRANT ALL ON public.scout_rotation_state TO service_role;

ALTER TABLE public.scout_rotation_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own scout rotation" ON public.scout_rotation_state;
CREATE POLICY "Users can view own scout rotation"
  ON public.scout_rotation_state
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create own scout rotation" ON public.scout_rotation_state;
CREATE POLICY "Users can create own scout rotation"
  ON public.scout_rotation_state
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own scout rotation" ON public.scout_rotation_state;
CREATE POLICY "Users can update own scout rotation"
  ON public.scout_rotation_state
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_scout_rotation_state_scope
  ON public.scout_rotation_state (user_id, exchange, environment, market_type);

DROP TRIGGER IF EXISTS update_scout_rotation_state_updated_at ON public.scout_rotation_state;
CREATE TRIGGER update_scout_rotation_state_updated_at
  BEFORE UPDATE ON public.scout_rotation_state
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.onyx_decisions
  DROP CONSTRAINT IF EXISTS onyx_decisions_decision_check;

ALTER TABLE public.onyx_decisions
  ADD CONSTRAINT onyx_decisions_decision_check
  CHECK (decision IN ('open','add','close','hold','reject','approve','approved','wait','rejected'));

CREATE INDEX IF NOT EXISTS idx_onyx_decisions_user_scan_symbol_side
  ON public.onyx_decisions (user_id, scan_id, symbol, side, decision_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_intents_user_created_state
  ON public.order_intents (user_id, created_at DESC, state);