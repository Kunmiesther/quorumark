CREATE TABLE IF NOT EXISTS public.paper_live_shadow_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  symbol text NOT NULL,
  leg text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('long','short')),
  regime text,
  trend_age_candles integer,
  directive_type text NOT NULL,
  paper_decision jsonb NOT NULL,
  live_decision jsonb,
  paper_price numeric,
  live_price numeric,
  price_delta_bps numeric,
  comparison_status text NOT NULL DEFAULT 'paper_only'
    CHECK (comparison_status IN ('paper_only','live_only','in_line','divergent')),
  divergence_reason text,
  notes jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS paper_live_shadow_ledger_user_time_idx
  ON public.paper_live_shadow_ledger (user_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS paper_live_shadow_ledger_symbol_time_idx
  ON public.paper_live_shadow_ledger (symbol, observed_at DESC);

GRANT SELECT ON public.paper_live_shadow_ledger TO authenticated;
GRANT ALL ON public.paper_live_shadow_ledger TO service_role;

ALTER TABLE public.paper_live_shadow_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "shadow_ledger_owner_read"
  ON public.paper_live_shadow_ledger
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
