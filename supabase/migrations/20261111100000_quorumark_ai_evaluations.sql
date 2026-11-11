-- AI provenance records. Model outputs are metadata and analysis only; they
-- never authorize execution or replace deterministic financial calculations.
create table if not exists public.strategy_exchange_ai_evaluations (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete cascade,
  strategy_id uuid references public.strategy_exchange_strategies(id) on delete set null,
  strategy_version_id uuid references public.strategy_exchange_versions(id) on delete set null,
  kind text not null check (kind in ('strategy_proposal', 'strategy_analysis', 'agent_evaluation')),
  provider text not null,
  model text not null,
  input jsonb not null,
  output jsonb not null,
  status text not null check (status in ('completed', 'failed')),
  created_at timestamptz not null default now()
);

alter table public.strategy_exchange_ai_evaluations enable row level security;
drop policy if exists "actors see own ai evaluations" on public.strategy_exchange_ai_evaluations;
create policy "actors see own ai evaluations" on public.strategy_exchange_ai_evaluations
  for select using (actor_id = auth.uid());
