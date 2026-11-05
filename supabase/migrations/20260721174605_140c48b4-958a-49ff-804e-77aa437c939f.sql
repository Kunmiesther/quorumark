
-- 1) Reconciliation flag (non-destructive; defaults false)
ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS capability_reconciliation_required boolean NOT NULL DEFAULT false;
ALTER TABLE public.user_strategy
  ADD COLUMN IF NOT EXISTS capability_reconciliation_required boolean NOT NULL DEFAULT false;

-- 2) Extend margin_policy_events with a superseded-by linkage.
ALTER TABLE public.margin_policy_events
  ADD COLUMN IF NOT EXISTS supersedes_event_id uuid REFERENCES public.margin_policy_events(id) ON DELETE SET NULL;

-- 3) Corrective audit rows: one per prior CROSS_MARGIN_POLICY_LOCK event,
--    linked via supersedes_event_id, capturing the venue snapshot.
INSERT INTO public.margin_policy_events
  (user_id, scope, scope_id, event, from_value, to_value, reason_code, detail, supersedes_event_id)
SELECT
  prior.user_id,
  prior.scope,
  prior.scope_id,
  'policy_superseded',
  prior.to_value,
  prior.to_value,
  'CROSS_MARGIN_POLICY_SUPERSEDED_BY_VENUE_REGISTRY',
  jsonb_build_object(
    'note', 'Global CROSS-only policy replaced by venue capability registry.',
    'prior_reason_code', prior.reason_code,
    'prior_event', prior.event,
    'venue_context', (
      SELECT jsonb_agg(DISTINCT ec.exchange)
        FROM public.exchange_connections ec
       WHERE ec.user_id = prior.user_id
         AND ec.status NOT IN ('disconnected','disabled')
    )
  ),
  prior.id
FROM public.margin_policy_events prior
WHERE prior.reason_code = 'CROSS_MARGIN_POLICY_LOCK'
  AND NOT EXISTS (
    SELECT 1 FROM public.margin_policy_events s
     WHERE s.supersedes_event_id = prior.id
       AND s.reason_code = 'CROSS_MARGIN_POLICY_SUPERSEDED_BY_VENUE_REGISTRY'
  );

-- 4) Flag any current row whose owner has NO active connection matching an
--    ApeX-only capability — those cannot rely on the historical cross value
--    and need runtime capability verification before new intents.
UPDATE public.user_strategy us
   SET capability_reconciliation_required = true
  WHERE NOT EXISTS (
    SELECT 1 FROM public.exchange_connections ec
     WHERE ec.id = us.connection_id
       AND ec.exchange = 'apex_omni'
       AND ec.status NOT IN ('disconnected','disabled')
  );

UPDATE public.paper_positions ps
   SET capability_reconciliation_required = true
  WHERE NOT EXISTS (
    SELECT 1 FROM public.exchange_connections ec
     WHERE ec.user_id = ps.user_id
       AND ec.exchange = 'apex_omni'
       AND ec.status NOT IN ('disconnected','disabled')
  );
