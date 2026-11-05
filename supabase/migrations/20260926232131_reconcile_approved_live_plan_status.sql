-- Correct only the save-handler label for already-approved Live configurations.
-- Version matches the verified production migration ledger.
-- No strategy rows, permissions, limits, leverage or positions are modified.
with candidates as materialized (
  select w.id,w.user_id,w.status,w.proposal,w.approved_at
  from public.autopilot_workflows w
  where w.status='awaiting_approval' and w.approved_at is not null
    and w.proposal->>'setupBook'='live'
    and exists (select 1 from public.user_strategy s where s.user_id=w.user_id
      and s.params->>'autopilot_workflow_id'=w.id::text and s.mode='live')
    and not exists (select 1 from public.user_strategy s where s.user_id=w.user_id
      and s.params->>'autopilot_workflow_id'=w.id::text and s.mode is distinct from 'live')
  for update
), audit as (
  insert into public.autopilot_risk_events(workflow_id,user_id,code,detail)
  select id,user_id,'approved_live_configuration_reconciled',
    jsonb_build_object('previousStatus',status,'approvedAt',approved_at,
      'previousProposalStatus',proposal->>'status','executionSettingsChanged',false)
  from candidates returning workflow_id
)
update public.autopilot_workflows w set status='live_configured',
  proposal=jsonb_set(w.proposal,'{status}','"live_configured"'::jsonb),updated_at=now()
from audit where w.id=audit.workflow_id;
