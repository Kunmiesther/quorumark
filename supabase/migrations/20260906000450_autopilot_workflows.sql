create table if not exists public.autopilot_workflows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  strategy_id uuid not null references public.strategies(id),
  goal_id text not null,
  goal_label text not null,
  authorized_capital numeric(18, 2) not null check (authorized_capital > 0),
  loss_limit numeric(18, 2) not null check (loss_limit > 0 and loss_limit <= authorized_capital),
  target_days integer not null check (target_days between 1 and 3650),
  risk_mode text not null check (risk_mode in ('conservative', 'moderate', 'aggressive')),
  status text not null default 'draft' check (status in ('draft', 'awaiting_approval', 'paper_validation', 'live_eligible', 'paused', 'rejected')),
  proposal jsonb not null default '{}'::jsonb,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.autopilot_workflows enable row level security;

create policy "Users read own autopilot workflows"
on public.autopilot_workflows for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users create own autopilot workflows"
on public.autopilot_workflows for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users update own autopilot workflows"
on public.autopilot_workflows for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

grant select, insert, update on public.autopilot_workflows to authenticated;

create index if not exists autopilot_workflows_user_updated_idx
on public.autopilot_workflows (user_id, updated_at desc);
