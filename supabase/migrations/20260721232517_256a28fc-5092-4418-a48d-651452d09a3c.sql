
-- Dual-direction Scout persistence: Offense (long) and Defense (short) evaluated
-- independently for every scanned eligible symbol. Backward-compatible: legacy
-- single-bias columns (bias/confidence/readiness/weighted_score/availability/
-- conflict) remain populated by existing writers; new per-side columns default
-- to safe zero/none values so old readers keep working.

-- 1. Add per-side score/state/evidence columns.
ALTER TABLE public.scout_signals
  ADD COLUMN IF NOT EXISTS long_score numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS short_score numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS long_state text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS short_state text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS long_aligned_tfs text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS short_aligned_tfs text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS long_reason_codes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS short_reason_codes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS long_fresh boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS short_fresh boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS long_insufficient boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS short_insufficient boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS dominant_side text NOT NULL DEFAULT 'balanced';

-- 2. Validate the state and dominance vocabularies (mirror dualDirection.ts).
ALTER TABLE public.scout_signals
  DROP CONSTRAINT IF EXISTS scout_signals_long_state_chk,
  DROP CONSTRAINT IF EXISTS scout_signals_short_state_chk,
  DROP CONSTRAINT IF EXISTS scout_signals_dominant_side_chk;
ALTER TABLE public.scout_signals
  ADD CONSTRAINT scout_signals_long_state_chk
    CHECK (long_state IN ('none','watching','confirmed','weakening','invalidated')),
  ADD CONSTRAINT scout_signals_short_state_chk
    CHECK (short_state IN ('none','watching','confirmed','weakening','invalidated')),
  ADD CONSTRAINT scout_signals_dominant_side_chk
    CHECK (dominant_side IN ('long','short','balanced'));

-- 3. Score bounds: absolute weighted scores in [0,1].
ALTER TABLE public.scout_signals
  DROP CONSTRAINT IF EXISTS scout_signals_long_score_bounds,
  DROP CONSTRAINT IF EXISTS scout_signals_short_score_bounds;
ALTER TABLE public.scout_signals
  ADD CONSTRAINT scout_signals_long_score_bounds
    CHECK (long_score >= 0 AND long_score <= 1),
  ADD CONSTRAINT scout_signals_short_score_bounds
    CHECK (short_score >= 0 AND short_score <= 1);

-- 4. Index for per-side ranking joins (fresh, non-insufficient sides only).
CREATE INDEX IF NOT EXISTS scout_signals_long_confirmed_idx
  ON public.scout_signals (user_id, symbol, created_at DESC)
  WHERE long_state = 'confirmed' AND long_fresh IS TRUE;
CREATE INDEX IF NOT EXISTS scout_signals_short_confirmed_idx
  ON public.scout_signals (user_id, symbol, created_at DESC)
  WHERE short_state = 'confirmed' AND short_fresh IS TRUE;

-- 5. Immutability trigger already blocks post-insert mutation of core columns;
-- extend it to cover the new per-side columns too. Recreate function.
CREATE OR REPLACE FUNCTION public.scout_signals_immutable_core()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.scan_id IS DISTINCT FROM OLD.scan_id
     OR NEW.symbol IS DISTINCT FROM OLD.symbol
     OR NEW.bias IS DISTINCT FROM OLD.bias
     OR NEW.weighted_score IS DISTINCT FROM OLD.weighted_score
     OR NEW.long_score IS DISTINCT FROM OLD.long_score
     OR NEW.short_score IS DISTINCT FROM OLD.short_score
     OR NEW.long_state IS DISTINCT FROM OLD.long_state
     OR NEW.short_state IS DISTINCT FROM OLD.short_state
     OR NEW.dominant_side IS DISTINCT FROM OLD.dominant_side
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'scout_signals core fields (including per-side) are immutable';
  END IF;
  RETURN NEW;
END;
$$;
