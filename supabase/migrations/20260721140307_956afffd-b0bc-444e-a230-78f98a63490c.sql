
-- Scout Multi-Timeframe Control Plane
-- All tables tenant-owned, RLS enforced, append-only where appropriate.

-- 1) Preferences (one row per user)
CREATE TABLE public.scout_preferences (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  active      boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.scout_preferences TO authenticated;
GRANT ALL ON public.scout_preferences TO service_role;
ALTER TABLE public.scout_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY scout_prefs_own_select ON public.scout_preferences FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY scout_prefs_own_insert ON public.scout_preferences FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY scout_prefs_own_update ON public.scout_preferences FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER scout_prefs_touch BEFORE UPDATE ON public.scout_preferences
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2) Scans (one row per fleet scan run)
CREATE TABLE public.scout_scans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  minute_bucket  timestamptz NOT NULL,
  symbol_count   int NOT NULL DEFAULT 0,
  health         text NOT NULL DEFAULT 'healthy',
  error          text,
  UNIQUE (user_id, minute_bucket)
);
CREATE INDEX scout_scans_user_started_idx ON public.scout_scans (user_id, started_at DESC);
GRANT SELECT, INSERT, UPDATE ON public.scout_scans TO authenticated;
GRANT ALL ON public.scout_scans TO service_role;
ALTER TABLE public.scout_scans ENABLE ROW LEVEL SECURITY;
CREATE POLICY scout_scans_own_select ON public.scout_scans FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY scout_scans_own_insert ON public.scout_scans FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY scout_scans_own_update ON public.scout_scans FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- 3) Signals (immutable per (user, scan, symbol) with idempotency)
CREATE TABLE public.scout_signals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scan_id        uuid NOT NULL REFERENCES public.scout_scans(id) ON DELETE CASCADE,
  symbol         text NOT NULL,
  bias           text NOT NULL,          -- long-priority | short-priority | balanced | no-signal
  confidence     numeric NOT NULL,       -- 0..1
  conflict       numeric NOT NULL,       -- 0..1
  readiness      text NOT NULL,          -- armed | watching | no-signal
  weighted_score numeric NOT NULL,       -- signed weighted sum -1..+1
  availability   numeric NOT NULL,       -- fraction of timeframes with data
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  invalidated_at timestamptz,
  UNIQUE (user_id, scan_id, symbol)
);
CREATE INDEX scout_signals_user_created_idx ON public.scout_signals (user_id, created_at DESC);
CREATE INDEX scout_signals_user_symbol_idx ON public.scout_signals (user_id, symbol, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON public.scout_signals TO authenticated;
GRANT ALL ON public.scout_signals TO service_role;
ALTER TABLE public.scout_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY scout_signals_own_select ON public.scout_signals FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY scout_signals_own_insert ON public.scout_signals FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
-- Only allow invalidated_at to be set forward; enforced in app + trigger below
CREATE POLICY scout_signals_own_update ON public.scout_signals FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.scout_signals_immutable_core()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.scan_id IS DISTINCT FROM OLD.scan_id
     OR NEW.symbol IS DISTINCT FROM OLD.symbol
     OR NEW.bias IS DISTINCT FROM OLD.bias
     OR NEW.confidence IS DISTINCT FROM OLD.confidence
     OR NEW.conflict IS DISTINCT FROM OLD.conflict
     OR NEW.readiness IS DISTINCT FROM OLD.readiness
     OR NEW.weighted_score IS DISTINCT FROM OLD.weighted_score
     OR NEW.availability IS DISTINCT FROM OLD.availability
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'scout_signals is immutable except for invalidated_at';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER scout_signals_immutable BEFORE UPDATE ON public.scout_signals
  FOR EACH ROW EXECUTE FUNCTION public.scout_signals_immutable_core();

-- 4) Evidence (per-timeframe rows for a signal)
CREATE TABLE public.scout_evidence (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_id       uuid NOT NULL REFERENCES public.scout_signals(id) ON DELETE CASCADE,
  timeframe       text NOT NULL,          -- M | W | D | H4 | H1 | M15 | M5
  state           text NOT NULL,          -- bullish | bearish | neutral | mixed | unavailable
  score           numeric NOT NULL,       -- -1..+1
  reasons         text[] NOT NULL DEFAULT '{}',
  last_closed_ts  bigint,
  stale           boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (signal_id, timeframe)
);
CREATE INDEX scout_evidence_user_idx ON public.scout_evidence (user_id, created_at DESC);
GRANT SELECT, INSERT ON public.scout_evidence TO authenticated;
GRANT ALL ON public.scout_evidence TO service_role;
ALTER TABLE public.scout_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY scout_evidence_own_select ON public.scout_evidence FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY scout_evidence_own_insert ON public.scout_evidence FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- 5) Corrections (append-only invalidation ledger)
CREATE TABLE public.scout_corrections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_id   uuid NOT NULL REFERENCES public.scout_signals(id) ON DELETE CASCADE,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scout_corrections_user_idx ON public.scout_corrections (user_id, created_at DESC);
GRANT SELECT, INSERT ON public.scout_corrections TO authenticated;
GRANT ALL ON public.scout_corrections TO service_role;
ALTER TABLE public.scout_corrections ENABLE ROW LEVEL SECURITY;
CREATE POLICY scout_corrections_own_select ON public.scout_corrections FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY scout_corrections_own_insert ON public.scout_corrections FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.scout_corrections_block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'scout_corrections is append-only'; END;
$$;
CREATE TRIGGER scout_corrections_no_update BEFORE UPDATE OR DELETE ON public.scout_corrections
  FOR EACH ROW EXECUTE FUNCTION public.scout_corrections_block_mutation();

-- 6) Outcomes (read-only excursion observations)
CREATE TABLE public.scout_outcomes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_id          uuid NOT NULL REFERENCES public.scout_signals(id) ON DELETE CASCADE,
  mfe_pct            numeric,
  mae_pct            numeric,
  hit_invalidation   boolean NOT NULL DEFAULT false,
  observed_until     timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (signal_id)
);
GRANT SELECT, INSERT, UPDATE ON public.scout_outcomes TO authenticated;
GRANT ALL ON public.scout_outcomes TO service_role;
ALTER TABLE public.scout_outcomes ENABLE ROW LEVEL SECURITY;
CREATE POLICY scout_outcomes_own_select ON public.scout_outcomes FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY scout_outcomes_own_insert ON public.scout_outcomes FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY scout_outcomes_own_update ON public.scout_outcomes FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- 7) Bias state (hysteresis memory per (user, symbol))
CREATE TABLE public.scout_bias_state (
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol       text NOT NULL,
  bias         text NOT NULL,
  streak       int NOT NULL DEFAULT 1,
  last_score   numeric NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, symbol)
);
GRANT SELECT, INSERT, UPDATE ON public.scout_bias_state TO authenticated;
GRANT ALL ON public.scout_bias_state TO service_role;
ALTER TABLE public.scout_bias_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY scout_bias_own_select ON public.scout_bias_state FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY scout_bias_own_insert ON public.scout_bias_state FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY scout_bias_own_update ON public.scout_bias_state FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
