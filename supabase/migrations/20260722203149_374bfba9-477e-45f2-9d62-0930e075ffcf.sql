UPDATE public.paper_engine_authority
SET mode = 'legacy',
    notes = 'Rollback: dynamic-universe execution disabled; legacy paper open path restored.'
WHERE mode = 'dynamic_universe';

UPDATE public.paper_engine_operations
SET state = 'dead_letter',
    recovery_reason = 'dynamic_universe_rollback_legacy_authority_restore',
    recovered_at = now(),
    updated_at = now()
WHERE state = 'claimed'
  AND op_key LIKE 'open:%';