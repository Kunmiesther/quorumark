-- ============================================================
-- AGENTIC PAPER OS: management timeline, review attribution,
-- bounded learning proposals, disabled promotion gate.
-- ============================================================

-- 1. POSITION-MANAGEMENT EVENTS ------------------------------
CREATE TABLE IF NOT EXISTS public.paper_position_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id uuid NOT NULL,
  parent_trace_id uuid,
  user_id uuid NOT NULL,
  paper_position_id uuid NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('long','short')),
  sequence integer NOT NULL DEFAULT 0,
  trigger text NOT NULL CHECK (trigger IN (
    'candle_close','volume_shift','liquidity_shift','rung_fill','structure_break',
    'tp_approach','hedge_opportunity','model_stance_change','degraded_execution'
  )),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_hash text NOT NULL,
  providers_attempted integer NOT NULL DEFAULT 3,
  providers_answered integer NOT NULL DEFAULT 0,
  participation text NOT NULL DEFAULT 'ai_unavailable'
    CHECK (participation IN ('full_3_of_3','degraded_2_of_3','degraded_1_of_3','ai_unavailable')),
  degraded boolean NOT NULL DEFAULT false,
  degraded_reason text,
  onyx_action text NOT NULL DEFAULT 'HOLD' CHECK (onyx_action IN (
    'HOLD','BANK_PROFIT','FILL_APPROVED_RUNG','MOVE_TO_APPROVED_BREAKEVEN','HEDGE','EXIT'
  )),
  onyx_rationale text NOT NULL DEFAULT '',
  onyx_confidence numeric,
  risk_checked boolean NOT NULL DEFAULT false,
  risk_passed boolean NOT NULL DEFAULT false,
  risk_code text,
  risk_detail jsonb,
  action_applied boolean NOT NULL DEFAULT false,
  apply_blocked_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS paper_pos_events_idempotent
  ON public.paper_position_events (user_id, paper_position_id, trigger, evidence_hash);
CREATE INDEX IF NOT EXISTS paper_pos_events_position_idx
  ON public.paper_position_events (paper_position_id, created_at DESC);
CREATE INDEX IF NOT EXISTS paper_pos_events_user_idx
  ON public.paper_position_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS paper_pos_events_parent_idx
  ON public.paper_position_events (parent_trace_id);

GRANT SELECT ON public.paper_position_events TO authenticated;
GRANT ALL ON public.paper_position_events TO service_role;
ALTER TABLE public.paper_position_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own position events readable" ON public.paper_position_events;
CREATE POLICY "own position events readable" ON public.paper_position_events
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- Per-event model opinions (same seat contract as entry orchestration).
CREATE TABLE IF NOT EXISTS public.paper_position_event_opinions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.paper_position_events(id) ON DELETE CASCADE,
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

CREATE UNIQUE INDEX IF NOT EXISTS paper_pos_event_opinions_seat
  ON public.paper_position_event_opinions (event_id, role);
CREATE INDEX IF NOT EXISTS paper_pos_event_opinions_user_idx
  ON public.paper_position_event_opinions (user_id, created_at DESC);

GRANT SELECT ON public.paper_position_event_opinions TO authenticated;
GRANT ALL ON public.paper_position_event_opinions TO service_role;
ALTER TABLE public.paper_position_event_opinions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own event opinions readable" ON public.paper_position_event_opinions;
CREATE POLICY "own event opinions readable" ON public.paper_position_event_opinions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- 2. REVIEW / LEARNING ATTRIBUTION ---------------------------
CREATE TABLE IF NOT EXISTS public.paper_trade_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  paper_trade_id uuid NOT NULL,
  trace_id uuid,
  symbol text NOT NULL,
  direction text NOT NULL,
  strategy text,
  regime text,
  scout_rank integer,
  pnl_net numeric NOT NULL DEFAULT 0,
  pnl_gross numeric NOT NULL DEFAULT 0,
  fees numeric NOT NULL DEFAULT 0,
  r_multiple numeric,
  hold_seconds integer,
  outcome text NOT NULL CHECK (outcome IN ('win','loss','scratch')),
  exit_reason text,
  participation text,
  onyx_decision text,
  onyx_correct boolean,
  model_attribution jsonb NOT NULL DEFAULT '[]'::jsonb,
  management_actions integer NOT NULL DEFAULT 0,
  unattributed boolean NOT NULL DEFAULT false,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS paper_trade_reviews_unique
  ON public.paper_trade_reviews (user_id, paper_trade_id);
CREATE INDEX IF NOT EXISTS paper_trade_reviews_user_idx
  ON public.paper_trade_reviews (user_id, closed_at DESC);

GRANT SELECT ON public.paper_trade_reviews TO authenticated;
GRANT ALL ON public.paper_trade_reviews TO service_role;
ALTER TABLE public.paper_trade_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own trade reviews readable" ON public.paper_trade_reviews;
CREATE POLICY "own trade reviews readable" ON public.paper_trade_reviews
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- 3. BOUNDED LEARNING: PROPOSALS REQUIRE OWNER APPROVAL -------
CREATE TABLE IF NOT EXISTS public.agentic_rule_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  scope text NOT NULL,
  title text NOT NULL,
  rationale text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_change jsonb NOT NULL DEFAULT '{}'::jsonb,
  sample_size integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agentic_rule_proposals_open
  ON public.agentic_rule_proposals (user_id, scope, title)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS agentic_rule_proposals_user_idx
  ON public.agentic_rule_proposals (user_id, created_at DESC);

GRANT SELECT, UPDATE ON public.agentic_rule_proposals TO authenticated;
GRANT ALL ON public.agentic_rule_proposals TO service_role;
ALTER TABLE public.agentic_rule_proposals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own proposals readable" ON public.agentic_rule_proposals;
CREATE POLICY "own proposals readable" ON public.agentic_rule_proposals
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "owner decides proposals" ON public.agentic_rule_proposals;
CREATE POLICY "owner decides proposals" ON public.agentic_rule_proposals
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id AND public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = user_id AND public.has_role(auth.uid(), 'admin'));

-- 4. PROMOTION GATE — CREATED DISABLED, OWNER-ONLY ------------
CREATE TABLE IF NOT EXISTS public.agentic_promotion_gate (
  user_id uuid PRIMARY KEY,
  -- Master switch for AGENTIC LIVE execution. Ships disabled and is never
  -- flipped by code; only an explicit owner action may change it.
  agentic_live_enabled boolean NOT NULL DEFAULT false,
  owner_approved boolean NOT NULL DEFAULT false,
  owner_approved_at timestamptz,
  -- Documented thresholds. Defaults are conservative starting points, not
  -- validated success criteria; the owner is expected to set them.
  min_sample_size integer NOT NULL DEFAULT 200,
  min_net_pnl numeric NOT NULL DEFAULT 0,
  min_expectancy numeric NOT NULL DEFAULT 0,
  min_profit_factor numeric NOT NULL DEFAULT 1.3,
  max_drawdown_pct numeric NOT NULL DEFAULT 15,
  max_degraded_rate_pct numeric NOT NULL DEFAULT 20,
  require_zero_missing_trace boolean NOT NULL DEFAULT true,
  require_zero_risk_violations boolean NOT NULL DEFAULT true,
  thresholds_note text NOT NULL DEFAULT
    'Defaults are conservative placeholders, NOT validated success criteria. The owner must review and set them before any promotion evaluation is meaningful.',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.agentic_promotion_gate TO authenticated;
GRANT ALL ON public.agentic_promotion_gate TO service_role;
ALTER TABLE public.agentic_promotion_gate ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own gate readable" ON public.agentic_promotion_gate;
CREATE POLICY "own gate readable" ON public.agentic_promotion_gate
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- Defence in depth: only an admin/owner row may ever carry an enabled gate.
CREATE OR REPLACE FUNCTION public.agentic_gate_owner_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.agentic_live_enabled AND NOT public.has_role(NEW.user_id, 'admin') THEN
    RAISE EXCEPTION 'agentic_live_owner_only: user % is not an owner', NEW.user_id;
  END IF;
  IF NEW.agentic_live_enabled AND NOT NEW.owner_approved THEN
    RAISE EXCEPTION 'agentic_live_requires_owner_approval';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agentic_gate_owner_only_trg ON public.agentic_promotion_gate;
CREATE TRIGGER agentic_gate_owner_only_trg
  BEFORE INSERT OR UPDATE ON public.agentic_promotion_gate
  FOR EACH ROW EXECUTE FUNCTION public.agentic_gate_owner_only();

-- 5. PERFORMANCE ROLLUP --------------------------------------
CREATE OR REPLACE VIEW public.paper_agentic_performance
WITH (security_invoker = true) AS
SELECT
  r.user_id,
  count(*)::integer                                              AS sample_size,
  count(*) FILTER (WHERE r.outcome = 'win')::integer              AS wins,
  count(*) FILTER (WHERE r.outcome = 'loss')::integer             AS losses,
  COALESCE(sum(r.pnl_net), 0)                                     AS net_pnl,
  COALESCE(avg(r.pnl_net), 0)                                     AS expectancy,
  COALESCE(sum(r.pnl_net) FILTER (WHERE r.pnl_net > 0), 0)        AS gross_profit,
  COALESCE(abs(sum(r.pnl_net) FILTER (WHERE r.pnl_net < 0)), 0)   AS gross_loss,
  count(*) FILTER (WHERE r.participation = 'full_3_of_3')::integer AS full_participation,
  count(*) FILTER (WHERE r.participation IS DISTINCT FROM 'full_3_of_3')::integer AS degraded_participation,
  count(*) FILTER (WHERE r.unattributed)::integer                 AS unattributed_trades
FROM public.paper_trade_reviews r
GROUP BY r.user_id;

GRANT SELECT ON public.paper_agentic_performance TO authenticated;
GRANT SELECT ON public.paper_agentic_performance TO service_role;