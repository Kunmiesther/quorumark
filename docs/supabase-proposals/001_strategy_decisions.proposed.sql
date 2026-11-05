-- Canonical deterministic decision ledger.
--
-- ONE row per completed 5-minute candle per verified live connection and
-- symbol, INCLUDING "wait". Before this table there was no record of a WAIT,
-- so every surface had to describe an ordinary quiet candle as "no decision",
-- "gate not passed", or "AI unavailable" — none of which were true.
--
-- ADDITIVE AND REVERSIBLE. Nothing here alters `strategy_candidates`,
-- `order_intents`, `order_audit`, `ai_committee_evaluations` or any other
-- existing table. `strategy_candidates` is preserved verbatim as historical
-- data; the live worker simply stops writing to it. Rolling back means
-- reverting the worker — no data migration, no backfill, no destructive step.

CREATE TABLE IF NOT EXISTS public.strategy_decisions (
  -- Deterministic: dec_v1_<sha256(schema|connection|symbol|candle_close_ms)>.
  -- Identity is EXACTLY the uniqueness tuple below, so a concurrent retry
  -- collapses onto this row instead of minting a second decision.
  decision_id text PRIMARY KEY,
  user_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  symbol text NOT NULL,
  strategy text NOT NULL,
  -- The leg `routing.leg_for_regime` armed for this candle. NULL when the
  -- candle could not be routed (market data or evaluator failure).
  armed_leg text,
  timeframe text NOT NULL DEFAULT '5m',
  candle_close_at timestamptz NOT NULL,

  -- THE DECISION. Immutable once written.
  direction text NOT NULL CHECK (direction IN ('long','short','wait')),
  reason_code text NOT NULL,
  reason text NOT NULL DEFAULT '',
  entry_zone jsonb,
  invalidation numeric,
  take_profits jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The immutable snapshot the strategy evaluated, carried with the decision
  -- so the AI committee reasons about EXACTLY these numbers and its recorded
  -- evidence hash matches instead of describing a re-fetched market.
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_hash text NOT NULL,
  schema_version text NOT NULL DEFAULT 'decision.v1',

  -- THE EXECUTION RECORD. Moves forward only; enforced by the edge function
  -- and by the trigger below so a late retry cannot downgrade a real result.
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

  -- One candle produces ONE decision. This is the same tuple `decision_id`
  -- hashes, stated a second time so the database — not the worker — is the
  -- thing that guarantees it.
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

-- Read-only for the browser. Every write goes through the service role in
-- the signed worker-ingest path; the client can never fabricate a decision.
DROP POLICY IF EXISTS "Owners read their own decisions" ON public.strategy_decisions;
CREATE POLICY "Owners read their own decisions"
  ON public.strategy_decisions FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- Immutability guard. The decision fields are write-once: an UPDATE may move
-- the execution record forward and nothing else. Defence in depth behind the
-- edge function, because this is the one table a bug could use to rewrite
-- history and make a WAIT look like a trade.
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


-- ---------------------------------------------------------------------------
-- Advisory AI opinions, keyed to the decision — NEVER to a candidate.
--
-- One row per (decision, role). A WAIT decision gets opinions too, which is
-- the point: the committee is there to learn from every candle, not only from
-- the rare ones that traded.
--
-- `status` distinguishes "asked, the provider was down" (unavailable) from
-- "never asked" (no row at all). Nothing in this table may be read as
-- agreement, and nothing that reads it may gate execution.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_decision_opinions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  decision_id text NOT NULL REFERENCES public.strategy_decisions(decision_id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('lead','risk','structure')),
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('evaluated','unavailable')),
  -- NULL for an unavailable provider. An absent answer is never stored as a
  -- direction, and never as agreement with the deterministic decision.
  direction text CHECK (direction IS NULL OR direction IN ('long','short','wait')),
  confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  summary text,
  risk_flags text[] NOT NULL DEFAULT '{}',
  latency_ms integer,
  prompt_version text NOT NULL,
  -- Must match the decision's hash: an opinion about different evidence is
  -- an opinion about a different candle.
  evidence_hash text NOT NULL,
  unavailable_reason text,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  -- SHADOW invariant, mirrored from ai_committee_evaluations: a row here can
  -- never be marked authoritative.
  advisory boolean NOT NULL DEFAULT true,
  CONSTRAINT ai_decision_opinions_advisory_only CHECK (advisory IS TRUE),
  CONSTRAINT ai_decision_opinions_unique UNIQUE (decision_id, role, evidence_hash),
  -- An evaluated seat must carry an opinion; an unavailable one must not.
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
