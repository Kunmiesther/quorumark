
-- Operational reliability spine: correlation events, health snapshots, decision ledger.

-- 1. Ops correlation event log
CREATE TABLE IF NOT EXISTS public.ops_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  correlation_id UUID NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('scout_scan','scout_envelope','onyx_decision','paper_intent','paper_execution','paper_fill','paper_outcome','watchdog','alert')),
  component TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','error','critical')),
  message TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  latency_ms INTEGER,
  server_ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.ops_events TO authenticated;
GRANT ALL ON public.ops_events TO service_role;
ALTER TABLE public.ops_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_events select own" ON public.ops_events FOR SELECT TO authenticated USING (auth.uid() = user_id OR user_id IS NULL);
CREATE POLICY "ops_events insert own" ON public.ops_events FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id OR user_id IS NULL);
CREATE INDEX IF NOT EXISTS ops_events_corr_idx ON public.ops_events (correlation_id, server_ts);
CREATE INDEX IF NOT EXISTS ops_events_user_ts_idx ON public.ops_events (user_id, server_ts DESC);
CREATE INDEX IF NOT EXISTS ops_events_stage_ts_idx ON public.ops_events (stage, server_ts DESC);

-- 2. Server-authored health snapshots (aggregated watchdog state)
CREATE TABLE IF NOT EXISTS public.ops_health_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  component TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('HEALTHY','DEGRADED','STALE','HALTED')),
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_success_at TIMESTAMPTZ,
  freshness_ms INTEGER,
  backlog_count INTEGER NOT NULL DEFAULT 0,
  p50_latency_ms INTEGER,
  p95_latency_ms INTEGER,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  server_ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.ops_health_snapshots TO authenticated;
GRANT ALL ON public.ops_health_snapshots TO service_role;
ALTER TABLE public.ops_health_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ops_health select own" ON public.ops_health_snapshots FOR SELECT TO authenticated USING (auth.uid() = user_id OR user_id IS NULL);
CREATE POLICY "ops_health insert own" ON public.ops_health_snapshots FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id OR user_id IS NULL);
CREATE INDEX IF NOT EXISTS ops_health_user_component_ts_idx ON public.ops_health_snapshots (user_id, component, server_ts DESC);

-- 3. Onyx decision ledger (every decision, including rejections)
CREATE TABLE IF NOT EXISTS public.onyx_decisions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  correlation_id UUID NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long','short','flat')),
  decision TEXT NOT NULL CHECK (decision IN ('open','add','close','hold','reject')),
  reject_reason TEXT,
  strategy TEXT,
  wallet_id UUID,
  confidence NUMERIC,
  scan_id UUID,
  envelope_version INTEGER NOT NULL,
  rules_version INTEGER NOT NULL,
  supporting_codes TEXT[] NOT NULL DEFAULT '{}',
  conflicting_codes TEXT[] NOT NULL DEFAULT '{}',
  risk_check JSONB NOT NULL DEFAULT '{}'::jsonb,
  signal_at TIMESTAMPTZ,
  decision_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  intent_at TIMESTAMPTZ,
  decision_latency_ms INTEGER,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.onyx_decisions TO authenticated;
GRANT ALL ON public.onyx_decisions TO service_role;
ALTER TABLE public.onyx_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "onyx_decisions select own" ON public.onyx_decisions FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "onyx_decisions insert own" ON public.onyx_decisions FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS onyx_decisions_user_ts_idx ON public.onyx_decisions (user_id, decision_at DESC);
CREATE INDEX IF NOT EXISTS onyx_decisions_corr_idx ON public.onyx_decisions (correlation_id);
CREATE INDEX IF NOT EXISTS onyx_decisions_symbol_ts_idx ON public.onyx_decisions (symbol, decision_at DESC);
