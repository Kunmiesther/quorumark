
-- =====================================================================
-- FUSION (paper observer) append-only tables
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.fusion_formation_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  prior_formation TEXT,
  new_formation TEXT NOT NULL,
  reason_codes TEXT[] NOT NULL DEFAULT '{}',
  regime_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence_band TEXT,
  decision_version TEXT NOT NULL,
  risk_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fusion_formation_events_user_created_idx
  ON public.fusion_formation_events (user_id, created_at DESC);
GRANT SELECT, INSERT ON public.fusion_formation_events TO authenticated;
GRANT ALL ON public.fusion_formation_events TO service_role;
ALTER TABLE public.fusion_formation_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fusion_ff_events_select_own"
  ON public.fusion_formation_events FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "fusion_ff_events_insert_own"
  ON public.fusion_formation_events FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.fusion_sleeves (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long','short')),
  virtual_notional NUMERIC(20,8) NOT NULL DEFAULT 0,
  virtual_margin NUMERIC(20,8) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol, side)
);
GRANT SELECT, INSERT, UPDATE ON public.fusion_sleeves TO authenticated;
GRANT ALL ON public.fusion_sleeves TO service_role;
ALTER TABLE public.fusion_sleeves ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fusion_sleeves_own"
  ON public.fusion_sleeves FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.fusion_recommendations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  symbol TEXT NOT NULL,
  recommended_formation TEXT NOT NULL,
  rationale TEXT,
  regime_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','accepted','rejected','expired')),
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fusion_recs_user_created_idx
  ON public.fusion_recommendations (user_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON public.fusion_recommendations TO authenticated;
GRANT ALL ON public.fusion_recommendations TO service_role;
ALTER TABLE public.fusion_recommendations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fusion_recs_own"
  ON public.fusion_recommendations FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- =====================================================================
-- LIFE MAP — earnings / payment / points lifecycle (append-only)
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.earnings_allocations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  obligation_id UUID,
  source TEXT NOT NULL,           -- 'paper' | 'live'
  strategy TEXT,                  -- engine strategy key
  amount NUMERIC(20,8) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'allocated' CHECK (status IN ('allocated','reversed')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS earnings_alloc_user_created_idx
  ON public.earnings_allocations (user_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON public.earnings_allocations TO authenticated;
GRANT ALL ON public.earnings_allocations TO service_role;
ALTER TABLE public.earnings_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "earnings_alloc_own"
  ON public.earnings_allocations FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.bill_payment_intents (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  obligation_id UUID NOT NULL,
  amount NUMERIC(20,8) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'ready_to_withdraw' CHECK (status IN (
    'ready_to_withdraw','withdrawal_detected','payment_pending','verified_paid','reversed'
  )),
  idempotency_key TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
GRANT SELECT, INSERT, UPDATE ON public.bill_payment_intents TO authenticated;
GRANT ALL ON public.bill_payment_intents TO service_role;
ALTER TABLE public.bill_payment_intents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bill_intents_own"
  ON public.bill_payment_intents FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.bill_withdrawal_links (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  intent_id UUID NOT NULL REFERENCES public.bill_payment_intents(id) ON DELETE CASCADE,
  withdrawal_ref TEXT NOT NULL,     -- external withdrawal identifier
  amount NUMERIC(20,8) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, withdrawal_ref)
);
GRANT SELECT, INSERT, UPDATE ON public.bill_withdrawal_links TO authenticated;
GRANT ALL ON public.bill_withdrawal_links TO service_role;
ALTER TABLE public.bill_withdrawal_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bill_wlinks_own"
  ON public.bill_withdrawal_links FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.point_ledger (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  points INTEGER NOT NULL,           -- positive = award, negative = compensating reversal
  reason TEXT NOT NULL,              -- 'bill_verified_paid' | 'reversal' | ...
  obligation_id UUID,
  intent_id UUID,
  idempotency_key TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS point_ledger_user_created_idx
  ON public.point_ledger (user_id, created_at DESC);
GRANT SELECT, INSERT ON public.point_ledger TO authenticated;
GRANT ALL ON public.point_ledger TO service_role;
ALTER TABLE public.point_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "point_ledger_select_own"
  ON public.point_ledger FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "point_ledger_insert_own"
  ON public.point_ledger FOR INSERT
  WITH CHECK (auth.uid() = user_id);
