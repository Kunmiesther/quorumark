CREATE TABLE IF NOT EXISTS public.strategy_decisions (
  decision_id text PRIMARY KEY,
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  symbol text NOT NULL,
  strategy text NOT NULL,
  armed_leg text,
  timeframe text NOT NULL DEFAULT '5m',
  candle_close_at timestamptz NOT NULL,
  direction text NOT NULL CHECK (direction IN ('long','short','wait')),
  reason_code text NOT NULL,
  reason text NOT NULL DEFAULT '',
  entry_zone jsonb,
  invalidation numeric,
  take_profits jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_hash text NOT NULL,
  schema_version text NOT NULL DEFAULT 'decision.v1',
  execution_state text NOT NULL DEFAULT 'not_reached'
    CHECK (execution_state IN (
      'not_reached','blocked','intent_created','submitted',
      'ambiguous','rejected','filled'
    )),
  execution_reason_code text,
  safety_checks jsonb,
  order_intent jsonb,
  apex_result jsonb,
  execution_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT strategy_decisions_one_per_candle
    UNIQUE (connection_id, symbol, candle_close_at)
);

CREATE INDEX IF NOT EXISTS strategy_decisions_symbol_candle_idx
  ON public.strategy_decisions (user_id, symbol, candle_close_at DESC);
CREATE INDEX IF NOT EXISTS strategy_decisions_execution_idx
  ON public.strategy_decisions (execution_state, candle_close_at DESC);

GRANT SELECT ON public.strategy_decisions TO authenticated;
GRANT ALL ON public.strategy_decisions TO service_role;

ALTER TABLE public.strategy_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners read their own decisions" ON public.strategy_decisions;
CREATE POLICY "Owners read their own decisions"
  ON public.strategy_decisions FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.strategy_decisions_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.decision_id     IS DISTINCT FROM OLD.decision_id
     OR NEW.user_id        IS DISTINCT FROM OLD.user_id
     OR NEW.connection_id  IS DISTINCT FROM OLD.connection_id
     OR NEW.symbol         IS DISTINCT FROM OLD.symbol
     OR NEW.candle_close_at IS DISTINCT FROM OLD.candle_close_at
     OR NEW.direction      IS DISTINCT FROM OLD.direction
     OR NEW.reason_code    IS DISTINCT FROM OLD.reason_code
     OR NEW.evidence_hash  IS DISTINCT FROM OLD.evidence_hash THEN
    RAISE EXCEPTION 'strategy_decisions: decision fields are immutable';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS strategy_decisions_guard_trg ON public.strategy_decisions;
CREATE TRIGGER strategy_decisions_guard_trg
  BEFORE UPDATE ON public.strategy_decisions
  FOR EACH ROW EXECUTE FUNCTION public.strategy_decisions_guard();

CREATE TABLE IF NOT EXISTS public.ai_decision_opinions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  decision_id text NOT NULL REFERENCES public.strategy_decisions(decision_id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('lead','risk','structure')),
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('evaluated','unavailable')),
  direction text CHECK (direction IS NULL OR direction IN ('long','short','wait')),
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

CREATE INDEX IF NOT EXISTS ai_decision_opinions_decision_idx
  ON public.ai_decision_opinions (decision_id);

GRANT SELECT ON public.ai_decision_opinions TO authenticated;
GRANT ALL ON public.ai_decision_opinions TO service_role;

ALTER TABLE public.ai_decision_opinions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners read their own decision opinions" ON public.ai_decision_opinions;
CREATE POLICY "Owners read their own decision opinions"
  ON public.ai_decision_opinions FOR SELECT TO authenticated
  USING (auth.uid() = user_id);