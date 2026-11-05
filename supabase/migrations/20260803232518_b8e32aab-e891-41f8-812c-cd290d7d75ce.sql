CREATE TABLE public.committee_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  cycle_key text NOT NULL,
  book text NOT NULL DEFAULT 'paper',
  candle_close_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'reviewing',
  universe_size integer NOT NULL DEFAULT 0,
  candidate_count integer NOT NULL DEFAULT 0,
  reviewed_count integer NOT NULL DEFAULT 0,
  seat_response_count integer NOT NULL DEFAULT 0,
  selected_symbol text,
  selected_direction text,
  selected_score numeric,
  no_trade_reason text,
  strategy_version text NOT NULL DEFAULT 'shortlist.v1',
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT committee_cycles_user_cycle_key UNIQUE (user_id, cycle_key)
);

GRANT SELECT ON public.committee_cycles TO authenticated;
GRANT ALL ON public.committee_cycles TO service_role;

ALTER TABLE public.committee_cycles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners read own committee cycles"
  ON public.committee_cycles FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Service role manages committee cycles"
  ON public.committee_cycles FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE INDEX committee_cycles_user_recent_idx
  ON public.committee_cycles (user_id, candle_close_at DESC);

CREATE TABLE public.committee_shortlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL REFERENCES public.committee_cycles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL,
  state text NOT NULL DEFAULT 'reviewing',
  rank integer,
  total_score numeric,
  score_components jsonb NOT NULL DEFAULT '{}'::jsonb,
  liquidity_usd numeric,
  spread_bps numeric,
  volatility_pct numeric,
  expected_net_edge_bps numeric,
  seat_decisions jsonb NOT NULL DEFAULT '[]'::jsonb,
  available_seats integer NOT NULL DEFAULT 0,
  unavailable_seats integer NOT NULL DEFAULT 0,
  verdict text,
  consensus_confidence numeric,
  risk_veto boolean NOT NULL DEFAULT false,
  rejection_reason text,
  candidate_id text,
  evaluation_id uuid,
  evidence_hash text,
  signal_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT committee_shortlist_unique_side UNIQUE (cycle_id, symbol, direction)
);

GRANT SELECT ON public.committee_shortlist TO authenticated;
GRANT ALL ON public.committee_shortlist TO service_role;

ALTER TABLE public.committee_shortlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners read own committee shortlist"
  ON public.committee_shortlist FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Service role manages committee shortlist"
  ON public.committee_shortlist FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE INDEX committee_shortlist_cycle_rank_idx
  ON public.committee_shortlist (cycle_id, rank NULLS LAST);
CREATE INDEX committee_shortlist_user_recent_idx
  ON public.committee_shortlist (user_id, created_at DESC);

CREATE TRIGGER committee_cycles_touch
  BEFORE UPDATE ON public.committee_cycles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER committee_shortlist_touch
  BEFORE UPDATE ON public.committee_shortlist
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.committee_cycles_retention_purge(_days integer DEFAULT 14)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted bigint;
BEGIN
  DELETE FROM public.committee_cycles
  WHERE candle_close_at < now() - make_interval(days => GREATEST(1, _days));
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.committee_cycles_retention_purge(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.committee_cycles_retention_purge(integer) TO service_role;