CREATE TABLE public.agentic_sweep_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  runtime_version text NOT NULL,
  positions_discovered integer NOT NULL DEFAULT 0 CHECK (positions_discovered >= 0),
  positions_eligible integer NOT NULL DEFAULT 0 CHECK (positions_eligible >= 0),
  skipped_by_reason jsonb NOT NULL DEFAULT '{}'::jsonb,
  events_written integer NOT NULL DEFAULT 0 CHECK (events_written >= 0),
  errors integer NOT NULL DEFAULT 0 CHECK (errors >= 0),
  error_categories text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'started' CHECK (status IN ('started','completed','completed_with_errors','failed')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
GRANT SELECT ON public.agentic_sweep_runs TO authenticated;
GRANT ALL ON public.agentic_sweep_runs TO service_role;
ALTER TABLE public.agentic_sweep_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own agentic sweep runs readable"
  ON public.agentic_sweep_runs FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE INDEX agentic_sweep_runs_user_started_idx
  ON public.agentic_sweep_runs (user_id, started_at DESC);

ALTER TABLE public.paper_position_events
  ADD COLUMN IF NOT EXISTS event_kind text NOT NULL DEFAULT 'management',
  ADD COLUMN IF NOT EXISTS entry_attribution text NOT NULL DEFAULT 'attributed',
  ADD COLUMN IF NOT EXISTS management_root_trace_id uuid;

ALTER TABLE public.paper_position_events
  DROP CONSTRAINT IF EXISTS paper_position_events_trigger_check;
ALTER TABLE public.paper_position_events
  ADD CONSTRAINT paper_position_events_trigger_check CHECK (trigger IN (
    'legacy_bootstrap','candle_close','volume_shift','liquidity_shift','rung_fill','structure_break',
    'tp_approach','hedge_opportunity','model_stance_change','degraded_execution'
  ));

ALTER TABLE public.paper_position_events
  ADD CONSTRAINT paper_position_events_event_kind_check
  CHECK (event_kind IN ('management','legacy_bootstrap')),
  ADD CONSTRAINT paper_position_events_entry_attribution_check
  CHECK (entry_attribution IN ('attributed','legacy_unattributed'));

CREATE INDEX IF NOT EXISTS paper_pos_events_management_root_idx
  ON public.paper_position_events (management_root_trace_id, created_at DESC);