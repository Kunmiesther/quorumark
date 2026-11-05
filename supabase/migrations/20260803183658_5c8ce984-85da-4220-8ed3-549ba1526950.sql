CREATE TABLE public.live_position_advisories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  position_id uuid NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL,
  candle_close_at timestamptz NOT NULL,
  trace_id uuid NOT NULL,
  evidence_hash text NOT NULL,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  seats_total integer NOT NULL DEFAULT 0,
  seats_available integer NOT NULL DEFAULT 0,
  consensus_action text NOT NULL DEFAULT 'no_change',
  consensus_confidence numeric,
  risk_check jsonb NOT NULL DEFAULT '{}'::jsonb,
  narrative text NOT NULL DEFAULT '',
  advisory boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT live_position_advisories_unique_candle UNIQUE (position_id, candle_close_at)
);

CREATE INDEX live_position_advisories_user_recent_idx
  ON public.live_position_advisories (user_id, candle_close_at DESC);

CREATE TABLE public.live_position_advisory_opinions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advisory_id uuid NOT NULL REFERENCES public.live_position_advisories(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  available boolean NOT NULL,
  unavailable_reason text,
  detail text,
  latency_ms integer NOT NULL DEFAULT 0,
  action text,
  confidence numeric,
  risk_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  rationale text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX live_position_advisory_opinions_advisory_idx
  ON public.live_position_advisory_opinions (advisory_id);

GRANT SELECT ON public.live_position_advisories TO authenticated;
GRANT ALL ON public.live_position_advisories TO service_role;
GRANT SELECT ON public.live_position_advisory_opinions TO authenticated;
GRANT ALL ON public.live_position_advisory_opinions TO service_role;

ALTER TABLE public.live_position_advisories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_position_advisory_opinions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own live advisories readable"
  ON public.live_position_advisories FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "own live advisory opinions readable"
  ON public.live_position_advisory_opinions FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE TRIGGER live_position_advisories_touch
  BEFORE UPDATE ON public.live_position_advisories
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();