-- Scout intelligence-plane market regime persistence (P1)
ALTER TABLE public.scout_signals
  ADD COLUMN IF NOT EXISTS market_regime TEXT,
  ADD COLUMN IF NOT EXISTS regime_evidence JSONB,
  ADD COLUMN IF NOT EXISTS regime_schema_version INTEGER;

-- Constrain market_regime to the versioned enumeration. NULL remains allowed
-- for legacy rows written before this migration.
ALTER TABLE public.scout_signals
  DROP CONSTRAINT IF EXISTS scout_signals_market_regime_chk;
ALTER TABLE public.scout_signals
  ADD CONSTRAINT scout_signals_market_regime_chk
  CHECK (
    market_regime IS NULL
    OR market_regime IN (
      'strong_uptrend',
      'strong_downtrend',
      'developing_trend',
      'ranging',
      'volatile',
      'reversal_forming',
      'opposing_to_open_position',
      'unknown'
    )
  );

-- Extend immutability trigger so the regime columns are as append-only as
-- the rest of the signal payload.
CREATE OR REPLACE FUNCTION public.scout_signals_immutable_core()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
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
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.market_regime IS DISTINCT FROM OLD.market_regime
     OR NEW.regime_evidence IS DISTINCT FROM OLD.regime_evidence
     OR NEW.regime_schema_version IS DISTINCT FROM OLD.regime_schema_version THEN
    RAISE EXCEPTION 'scout_signals is immutable except for invalidated_at';
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON COLUMN public.scout_signals.market_regime IS
  'Scout intelligence-plane market regime (P1). One of the versioned enum '
  'values or unknown. Consumed by ONYX to select FORMATION.';
COMMENT ON COLUMN public.scout_signals.regime_evidence IS
  'Deterministic RegimeEvidence object emitted by classifyMarketRegime — '
  'confidence, conflict, availability, reason codes, schema version.';