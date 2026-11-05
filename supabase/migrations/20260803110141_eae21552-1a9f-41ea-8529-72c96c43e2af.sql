CREATE OR REPLACE FUNCTION public.paper_ai_orchestrations_provenance_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.evidence_hash IS NULL OR NEW.evidence_hash !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'ORCHESTRATION_EVIDENCE_HASH_INVALID';
    END IF;
    IF NEW.evidence IS NULL THEN
      RAISE EXCEPTION 'ORCHESTRATION_EVIDENCE_REQUIRED';
    END IF;
    IF NEW.candidate_key IS NULL OR NEW.candle_ts_ms IS NULL THEN
      RAISE EXCEPTION 'ORCHESTRATION_CANDIDATE_BINDING_REQUIRED';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Immutable provenance: the engine transaction that opened the trace owns
    -- these values forever.
    IF NEW.trace_id      IS DISTINCT FROM OLD.trace_id
    OR NEW.user_id       IS DISTINCT FROM OLD.user_id
    OR NEW.candidate_key IS DISTINCT FROM OLD.candidate_key
    OR NEW.symbol        IS DISTINCT FROM OLD.symbol
    OR NEW.direction     IS DISTINCT FROM OLD.direction
    OR NEW.strategy      IS DISTINCT FROM OLD.strategy
    OR NEW.candle_ts_ms  IS DISTINCT FROM OLD.candle_ts_ms
    OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash
    OR NEW.evidence      IS DISTINCT FROM OLD.evidence
    OR NEW.record_kind   IS DISTINCT FROM OLD.record_kind
    THEN
      RAISE EXCEPTION 'ORCHESTRATION_PROVENANCE_IMMUTABLE';
    END IF;

    -- A correction may only ever downgrade an authorisation.
    IF OLD.gate_allowed = false AND NEW.gate_allowed = true THEN
      RAISE EXCEPTION 'ORCHESTRATION_REAUTHORIZATION_FORBIDDEN';
    END IF;
    IF OLD.snapshot_valid = false AND NEW.snapshot_valid = true THEN
      RAISE EXCEPTION 'ORCHESTRATION_SNAPSHOT_REVALIDATION_FORBIDDEN';
    END IF;
  END IF;

  -- The only shape that may authorise a paper trade.
  IF NEW.gate_allowed = true THEN
    IF NEW.snapshot_valid IS NOT TRUE THEN
      RAISE EXCEPTION 'ORCHESTRATION_GATE_REQUIRES_VALID_SNAPSHOT';
    END IF;
    IF NEW.record_kind <> 'runtime' THEN
      RAISE EXCEPTION 'ORCHESTRATION_GATE_REQUIRES_RUNTIME_RECORD';
    END IF;
    IF COALESCE(NEW.providers_attempted, 0) < 3 THEN
      RAISE EXCEPTION 'ORCHESTRATION_GATE_REQUIRES_THREE_PROVIDER_ATTEMPTS';
    END IF;
    IF NEW.risk_checked IS NOT TRUE OR NEW.risk_passed IS NOT TRUE THEN
      RAISE EXCEPTION 'ORCHESTRATION_GATE_REQUIRES_PASSED_RISK_CHECK';
    END IF;
    IF NEW.onyx_decision <> 'enter' OR NEW.terminal_outcome <> 'TRADE_CANDIDATE' THEN
      RAISE EXCEPTION 'ORCHESTRATION_GATE_REQUIRES_ENTER_TRADE_CANDIDATE';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS paper_ai_orchestrations_provenance_guard_trg ON public.paper_ai_orchestrations;
CREATE TRIGGER paper_ai_orchestrations_provenance_guard_trg
  BEFORE INSERT OR UPDATE ON public.paper_ai_orchestrations
  FOR EACH ROW EXECUTE FUNCTION public.paper_ai_orchestrations_provenance_guard();