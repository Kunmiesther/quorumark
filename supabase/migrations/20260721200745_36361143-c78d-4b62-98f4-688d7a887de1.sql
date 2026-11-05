
-- =========================================================================
-- C1 — Dynamic market universe foundation (paper-only, flag OFF by default)
-- =========================================================================

-- Enums --------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.scout_universe_health AS ENUM ('healthy','degraded','offline','unverified');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.scout_ranking_bucket AS ENUM ('watching','eligible','ranked','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.scout_override_kind AS ENUM ('allow','deny','emergency_allow');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.scout_market_type AS ENUM ('paper','futures','spot');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.scout_environment AS ENUM ('paper','testnet','mainnet');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 1. scout_universe_snapshots ---------------------------------------------

CREATE TABLE IF NOT EXISTS public.scout_universe_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id UUID NULL,                             -- nullable for paper (no exchange_connections row)
  exchange TEXT NOT NULL,                              -- e.g. 'apex_omni','bydfi','paper'
  environment public.scout_environment NOT NULL,
  market_type public.scout_market_type NOT NULL,
  adapter_version INT NOT NULL,                        -- venue adapter version
  capability_version INT NOT NULL,                     -- venue_capabilities row version
  universe_version INT NOT NULL DEFAULT 1,             -- eligibility ruleset version
  ranking_version INT NOT NULL DEFAULT 1,              -- ranking formula version
  health public.scout_universe_health NOT NULL,
  exchange_symbol_count INT NOT NULL DEFAULT 0,        -- total tradable instruments returned by adapter
  eligible_count INT NOT NULL DEFAULT 0,               -- after eligibility filter
  ranked_count INT NOT NULL DEFAULT 0,                 -- passed to ranking
  rejected_count INT NOT NULL DEFAULT 0,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  correlation_id UUID NOT NULL,                        -- ties snapshot -> rankings -> ops_events
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,           -- adapter meta, degraded reasons, etc.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scout_universe_snapshots_scope
  ON public.scout_universe_snapshots (user_id, exchange, environment, market_type, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_scout_universe_snapshots_correlation
  ON public.scout_universe_snapshots (correlation_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.scout_universe_snapshots TO authenticated;
GRANT ALL ON public.scout_universe_snapshots TO service_role;

ALTER TABLE public.scout_universe_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners read universe snapshots"
  ON public.scout_universe_snapshots FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Owners write universe snapshots"
  ON public.scout_universe_snapshots FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owners update universe snapshots"
  ON public.scout_universe_snapshots FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owners delete universe snapshots"
  ON public.scout_universe_snapshots FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

CREATE TRIGGER trg_scout_universe_snapshots_updated_at
  BEFORE UPDATE ON public.scout_universe_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. scout_symbol_rankings -------------------------------------------------

CREATE TABLE IF NOT EXISTS public.scout_symbol_rankings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  snapshot_id UUID NOT NULL REFERENCES public.scout_universe_snapshots(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  bucket public.scout_ranking_bucket NOT NULL,
  rank INT NULL,                                       -- non-null only when bucket='ranked'
  raw_score NUMERIC NOT NULL DEFAULT 0,
  adjusted_score NUMERIC NOT NULL DEFAULT 0,           -- after hysteresis / context
  direction TEXT NOT NULL DEFAULT 'none',              -- 'long' | 'short' | 'none' | 'hedge' | 'wait'
  score_components JSONB NOT NULL DEFAULT '{}'::jsonb, -- {regime, alignment, readiness, ...}
  rejection_reasons TEXT[] NOT NULL DEFAULT '{}',      -- empty when bucket != 'rejected'
  exchange_max_leverage NUMERIC NULL,
  liquidity_usd NUMERIC NULL,
  spread_bps NUMERIC NULL,
  volatility_pct NUMERIC NULL,
  signal_fresh BOOLEAN NOT NULL DEFAULT false,
  correlation_id UUID NOT NULL,
  ranking_version INT NOT NULL DEFAULT 1,
  universe_version INT NOT NULL DEFAULT 1,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_scout_symbol_rankings_snapshot
  ON public.scout_symbol_rankings (snapshot_id, rank NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_scout_symbol_rankings_user_symbol
  ON public.scout_symbol_rankings (user_id, symbol, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_scout_symbol_rankings_bucket
  ON public.scout_symbol_rankings (user_id, bucket, generated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.scout_symbol_rankings TO authenticated;
GRANT ALL ON public.scout_symbol_rankings TO service_role;

ALTER TABLE public.scout_symbol_rankings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners read rankings"
  ON public.scout_symbol_rankings FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Owners write rankings"
  ON public.scout_symbol_rankings FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owners update rankings"
  ON public.scout_symbol_rankings FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owners delete rankings"
  ON public.scout_symbol_rankings FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- 3. scout_universe_overrides ---------------------------------------------

CREATE TABLE IF NOT EXISTS public.scout_universe_overrides (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id UUID NULL,
  exchange TEXT NOT NULL,
  environment public.scout_environment NOT NULL,
  market_type public.scout_market_type NOT NULL,
  symbol TEXT NOT NULL,
  kind public.scout_override_kind NOT NULL,
  reason TEXT NULL,
  expires_at TIMESTAMPTZ NULL,                         -- null = permanent
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, exchange, environment, market_type, symbol, kind)
);

CREATE INDEX IF NOT EXISTS idx_scout_universe_overrides_lookup
  ON public.scout_universe_overrides (user_id, exchange, environment, market_type, symbol);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.scout_universe_overrides TO authenticated;
GRANT ALL ON public.scout_universe_overrides TO service_role;

ALTER TABLE public.scout_universe_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners manage overrides"
  ON public.scout_universe_overrides FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER trg_scout_universe_overrides_updated_at
  BEFORE UPDATE ON public.scout_universe_overrides
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 4. scout_ranking_state (rank-band hysteresis) ---------------------------

CREATE TABLE IF NOT EXISTS public.scout_ranking_state (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id UUID NULL,
  exchange TEXT NOT NULL,
  environment public.scout_environment NOT NULL,
  market_type public.scout_market_type NOT NULL,
  symbol TEXT NOT NULL,
  last_bucket public.scout_ranking_bucket NOT NULL DEFAULT 'watching',
  last_rank INT NULL,
  last_adjusted_score NUMERIC NOT NULL DEFAULT 0,
  streak INT NOT NULL DEFAULT 1,                       -- consecutive scans in same bucket
  cooldown_until TIMESTAMPTZ NULL,                     -- must remain in current bucket until this ts
  last_transition_at TIMESTAMPTZ NULL,
  ranking_version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, exchange, environment, market_type, symbol)
);

CREATE INDEX IF NOT EXISTS idx_scout_ranking_state_scope
  ON public.scout_ranking_state (user_id, exchange, environment, market_type);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.scout_ranking_state TO authenticated;
GRANT ALL ON public.scout_ranking_state TO service_role;

ALTER TABLE public.scout_ranking_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners manage ranking state"
  ON public.scout_ranking_state FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER trg_scout_ranking_state_updated_at
  BEFORE UPDATE ON public.scout_ranking_state
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
