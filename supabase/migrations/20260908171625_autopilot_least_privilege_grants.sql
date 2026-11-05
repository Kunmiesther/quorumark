-- Supabase-created tables can inherit broad default API grants. Autopilot is
-- read-only for signed-in clients; every mutation is mediated by the Edge
-- Function after validating the caller and enforcing atomic capital limits.
revoke all privileges on table public.autopilot_workflows from anon, authenticated;
grant select on table public.autopilot_workflows to authenticated;

revoke all privileges on table public.autopilot_risk_events from anon, authenticated;
grant select on table public.autopilot_risk_events to authenticated;
