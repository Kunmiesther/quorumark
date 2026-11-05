CREATE OR REPLACE FUNCTION public.paper_ai_orchestrations_provenance_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_initial_finalize boolean := false;
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

    v_initial_finalize :=
      OLD.gate_allowed = false
      AND OLD.onyx_decision = 'wait'
      AND OLD.terminal_outcome = 'NO_TRADE_STRATEGY'
      AND OLD.risk_checked = false
      AND OLD.risk_passed = false
      AND OLD.providers_answered = 0
      AND OLD.paper_position_id IS NULL
      AND OLD.corrected_at IS NULL;

    IF OLD.gate_allowed = false AND NEW.gate_allowed = true AND NOT v_initial_finalize THEN
      RAISE EXCEPTION 'ORCHESTRATION_REAUTHORIZATION_FORBIDDEN';
    END IF;
    IF OLD.snapshot_valid = false AND NEW.snapshot_valid = true THEN
      RAISE EXCEPTION 'ORCHESTRATION_SNAPSHOT_REVALIDATION_FORBIDDEN';
    END IF;
  END IF;

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