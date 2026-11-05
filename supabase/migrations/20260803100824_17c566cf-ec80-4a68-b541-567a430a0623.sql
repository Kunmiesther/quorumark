CREATE TABLE IF NOT EXISTS public.paper_ai_orchestrations (
  trace_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  candidate_key text NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('long','short')),
  strategy text NOT NULL,
  timeframe text NOT NULL DEFAULT '5m',
  candle_ts_ms bigint NOT NULL DEFAULT 0,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_hash text NOT NULL,
  prompt_version text,
  providers_attempted integer NOT NULL DEFAULT 0,
  providers_answered integer NOT NULL DEFAULT 0,
  participation text NOT NULL DEFAULT 'ai_unavailable'
    CHECK (participation IN ('full_3_of_3','degraded_2_of_3','degraded_1_of_3','ai_unavailable')),
  degraded boolean NOT NULL DEFAULT false,
  degraded_reason text,
  committee_verdict text,
  onyx_decision text NOT NULL DEFAULT 'wait' CHECK (onyx_decision IN ('enter','wait','reject')),
  onyx_rationale text NOT NULL DEFAULT '',
  onyx_confidence numeric,
  onyx_decision_id uuid,
  risk_checked boolean NOT NULL DEFAULT false,
  risk_passed boolean NOT NULL DEFAULT false,
  risk_code text,
  risk_detail jsonb,
  terminal_outcome text NOT NULL DEFAULT 'NO_TRADE_STRATEGY'
    CHECK (terminal_outcome IN ('TRADE_CANDIDATE','NO_TRADE_STRATEGY','NO_TRADE_RISK','PIPELINE_ERROR')),
  gate_allowed boolean NOT NULL DEFAULT false,
  paper_position_id uuid,
  paper_trade_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS paper_ai_orch_unique_candidate
  ON public.paper_ai_orchestrations (user_id, candidate_key, evidence_hash);
CREATE INDEX IF NOT EXISTS paper_ai_orch_user_created_idx
  ON public.paper_ai_orchestrations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS paper_ai_orch_gate_idx
  ON public.paper_ai_orchestrations (user_id, symbol, direction, created_at DESC);
CREATE INDEX IF NOT EXISTS paper_ai_orch_position_idx
  ON public.paper_ai_orchestrations (paper_position_id);

GRANT SELECT ON public.paper_ai_orchestrations TO authenticated;
GRANT ALL ON public.paper_ai_orchestrations TO service_role;
ALTER TABLE public.paper_ai_orchestrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own orchestrations readable" ON public.paper_ai_orchestrations;
CREATE POLICY "own orchestrations readable" ON public.paper_ai_orchestrations
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.paper_ai_opinions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id uuid NOT NULL REFERENCES public.paper_ai_orchestrations(trace_id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('evaluated','unavailable')),
  direction text CHECK (direction IS NULL OR direction IN ('long','short','wait')),
  confidence numeric,
  summary text,
  risk_flags text[] NOT NULL DEFAULT '{}',
  latency_ms integer,
  prompt_version text,
  unavailable_reason text,
  advisory boolean NOT NULL DEFAULT true CHECK (advisory),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS paper_ai_opinions_unique_seat
  ON public.paper_ai_opinions (trace_id, role);
CREATE INDEX IF NOT EXISTS paper_ai_opinions_user_idx
  ON public.paper_ai_opinions (user_id, created_at DESC);

GRANT SELECT ON public.paper_ai_opinions TO authenticated;
GRANT ALL ON public.paper_ai_opinions TO service_role;
ALTER TABLE public.paper_ai_opinions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own opinions readable" ON public.paper_ai_opinions;
CREATE POLICY "own opinions readable" ON public.paper_ai_opinions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS orchestration_trace_id uuid,
  ADD COLUMN IF NOT EXISTS onyx_decision_id uuid;
ALTER TABLE public.paper_trades
  ADD COLUMN IF NOT EXISTS orchestration_trace_id uuid,
  ADD COLUMN IF NOT EXISTS onyx_decision_id uuid;

CREATE INDEX IF NOT EXISTS paper_positions_trace_idx
  ON public.paper_positions (orchestration_trace_id);
CREATE INDEX IF NOT EXISTS paper_trades_trace_idx
  ON public.paper_trades (orchestration_trace_id);

CREATE OR REPLACE FUNCTION public.paper_positions_require_orchestration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trace uuid;
  v_onyx uuid;
BEGIN
  IF NEW.orchestration_trace_id IS NULL THEN
    SELECT o.trace_id, o.onyx_decision_id
      INTO v_trace, v_onyx
      FROM public.paper_ai_orchestrations o
     WHERE o.user_id = NEW.user_id
       AND o.symbol = NEW.symbol
       AND o.direction = NEW.direction
       AND o.gate_allowed = true
       AND o.risk_passed = true
       AND o.terminal_outcome = 'TRADE_CANDIDATE'
       AND o.paper_position_id IS NULL
       AND o.created_at > now() - interval '20 minutes'
     ORDER BY o.created_at DESC
     LIMIT 1;
    NEW.orchestration_trace_id := v_trace;
    IF NEW.onyx_decision_id IS NULL THEN NEW.onyx_decision_id := v_onyx; END IF;
  END IF;

  IF NEW.orchestration_trace_id IS NULL THEN
    RAISE EXCEPTION 'paper_orchestration_missing: no linked AI orchestration trace for %/%',
      NEW.symbol, NEW.direction USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS paper_positions_require_orchestration_trg ON public.paper_positions;
CREATE TRIGGER paper_positions_require_orchestration_trg
  BEFORE INSERT ON public.paper_positions
  FOR EACH ROW EXECUTE FUNCTION public.paper_positions_require_orchestration();

CREATE OR REPLACE FUNCTION public.paper_positions_bind_orchestration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.paper_ai_orchestrations
     SET paper_position_id = NEW.id, updated_at = now()
   WHERE trace_id = NEW.orchestration_trace_id
     AND paper_position_id IS NULL;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS paper_positions_bind_orchestration_trg ON public.paper_positions;
CREATE TRIGGER paper_positions_bind_orchestration_trg
  AFTER INSERT ON public.paper_positions
  FOR EACH ROW EXECUTE FUNCTION public.paper_positions_bind_orchestration();

CREATE OR REPLACE FUNCTION public.paper_trades_inherit_orchestration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trace uuid;
  v_onyx uuid;
BEGIN
  IF NEW.orchestration_trace_id IS NULL AND NEW.position_id IS NOT NULL THEN
    SELECT p.orchestration_trace_id, p.onyx_decision_id
      INTO v_trace, v_onyx
      FROM public.paper_positions p
     WHERE p.id = NEW.position_id;
    NEW.orchestration_trace_id := v_trace;
    IF NEW.onyx_decision_id IS NULL THEN NEW.onyx_decision_id := v_onyx; END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS paper_trades_inherit_orchestration_trg ON public.paper_trades;
CREATE TRIGGER paper_trades_inherit_orchestration_trg
  BEFORE INSERT ON public.paper_trades
  FOR EACH ROW EXECUTE FUNCTION public.paper_trades_inherit_orchestration();

CREATE OR REPLACE FUNCTION public.paper_trades_bind_orchestration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.orchestration_trace_id IS NOT NULL THEN
    UPDATE public.paper_ai_orchestrations
       SET paper_trade_id = NEW.id, updated_at = now()
     WHERE trace_id = NEW.orchestration_trace_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS paper_trades_bind_orchestration_trg ON public.paper_trades;
CREATE TRIGGER paper_trades_bind_orchestration_trg
  AFTER INSERT ON public.paper_trades
  FOR EACH ROW EXECUTE FUNCTION public.paper_trades_bind_orchestration();

CREATE OR REPLACE VIEW public.paper_ai_participation_metrics
WITH (security_invoker = true) AS
SELECT
  o.user_id,
  count(*) FILTER (WHERE o.participation = 'full_3_of_3')      AS full_3_of_3,
  count(*) FILTER (WHERE o.participation = 'degraded_2_of_3')  AS degraded_2_of_3,
  count(*) FILTER (WHERE o.participation = 'degraded_1_of_3')  AS degraded_1_of_3,
  count(*) FILTER (WHERE o.participation = 'ai_unavailable')   AS ai_unavailable,
  count(*) FILTER (WHERE o.terminal_outcome = 'TRADE_CANDIDATE') AS trade_candidates,
  count(*) FILTER (WHERE o.onyx_decision = 'wait')             AS wait_decisions,
  count(*)                                                     AS orchestrations,
  (SELECT count(*) FROM public.paper_positions p
     WHERE p.user_id = o.user_id
       AND p.orchestration_trace_id IS NULL
       AND p.created_at > now() - interval '30 days')          AS missing_trace_violations
FROM public.paper_ai_orchestrations o
WHERE o.created_at > now() - interval '30 days'
GROUP BY o.user_id;

GRANT SELECT ON public.paper_ai_participation_metrics TO authenticated;
GRANT ALL ON public.paper_ai_participation_metrics TO service_role;