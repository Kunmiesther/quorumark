alter table public.trades
add column if not exists book text not null default 'paper'
check (book in ('paper', 'live'));

alter table public.autopilot_workflows
add column if not exists validation jsonb not null default '{}'::jsonb,
add column if not exists evaluated_at timestamptz;

drop policy if exists "Users update own autopilot workflows" on public.autopilot_workflows;
revoke update on public.autopilot_workflows from authenticated;

create table if not exists public.autopilot_risk_events (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.autopilot_workflows(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  code text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.autopilot_risk_events enable row level security;

create policy "Users read own autopilot risk events"
on public.autopilot_risk_events for select
to authenticated
using ((select auth.uid()) = user_id);

grant select on public.autopilot_risk_events to authenticated;

create index if not exists trades_paper_validation_idx
on public.trades (user_id, strategy_id, closed_at)
where book = 'paper';

create index if not exists autopilot_risk_events_workflow_idx
on public.autopilot_risk_events (workflow_id, created_at desc);
