ALTER TABLE public.positions
  ADD COLUMN IF NOT EXISTS tp_state text NOT NULL DEFAULT 'PENDING_COUNCIL_REVIEW',
  ADD COLUMN IF NOT EXISTS tp_review_seq integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tp_candles_required integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS tp_execution_timeframe text NOT NULL DEFAULT '5m',
  ADD COLUMN IF NOT EXISTS tp_fill_ts timestamptz,
  ADD COLUMN IF NOT EXISTS tp_price numeric,
  ADD COLUMN IF NOT EXISTS tp_venue_order_id text,
  ADD COLUMN IF NOT EXISTS tp_last_decision text,
  ADD COLUMN IF NOT EXISTS tp_last_reviewed_at timestamptz;

CREATE TABLE IF NOT EXISTS public.live_tp_council_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id uuid NOT NULL REFERENCES public.positions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  review_key text NOT NULL UNIQUE,
  review_seq integer NOT NULL,
  timeframe text NOT NULL,
  fill_ts timestamptz NOT NULL,
  candles_counted integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'in_progress',
  decision text,
  decision_price numeric,
  decision_size numeric,
  rationale text,
  degraded boolean NOT NULL DEFAULT false,
  council_inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  council_opinions jsonb NOT NULL DEFAULT '[]'::jsonb,
  intent_idempotency_key text,
  venue_order_id text,
  reject_reason text,
  final_state text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS live_tp_council_reviews_position_idx
  ON public.live_tp_council_reviews (position_id, review_seq DESC);

GRANT SELECT ON public.live_tp_council_reviews TO authenticated;
GRANT ALL ON public.live_tp_council_reviews TO service_role;

ALTER TABLE public.live_tp_council_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read their own TP council reviews" ON public.live_tp_council_reviews;
CREATE POLICY "Users read their own TP council reviews"
  ON public.live_tp_council_reviews FOR SELECT TO authenticated
  USING (auth.uid() = user_id);