-- Decision-time snapshots are kept independently of the short-retention
-- committee tables. Later directional benchmarks are separate, immutable
-- rows: they are NOT filled orders, P&L, or evidence of an executable entry.
create table public.missed_opportunities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cycle_id uuid not null,
  book text not null check (book in ('paper', 'live')),
  symbol text not null,
  direction text not null check (direction in ('long', 'short')),
  decision_at timestamptz not null,
  reference_price numeric not null check (reference_price > 0),
  decision_state text not null,
  rejection_reason text,
  strategy_version text not null,
  entry_plan jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  unique (cycle_id, symbol, direction)
);

create index missed_opportunities_due_idx
  on public.missed_opportunities (decision_at desc, user_id);

create table public.missed_opportunity_outcomes (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.missed_opportunities(id) on delete cascade,
  window_key text not null check (window_key in ('1h', '4h', '24h')),
  status text not null check (status in ('complete', 'insufficient_data')),
  mfe_pct numeric,
  mae_pct numeric,
  net_pct numeric,
  bars_used integer not null default 0 check (bars_used >= 0),
  method_version text not null,
  evaluated_at timestamptz not null default now(),
  unique (opportunity_id, window_key)
);

create index missed_opportunity_outcomes_lookup_idx
  on public.missed_opportunity_outcomes (opportunity_id, window_key);

alter table public.missed_opportunities enable row level security;
alter table public.missed_opportunity_outcomes enable row level security;

grant select on public.missed_opportunities to authenticated;
grant select on public.missed_opportunity_outcomes to authenticated;
grant all on public.missed_opportunities to service_role;
grant all on public.missed_opportunity_outcomes to service_role;

create policy missed_opportunities_owner_read on public.missed_opportunities
  for select to authenticated using (user_id = (select auth.uid()));

create policy missed_opportunity_outcomes_owner_read on public.missed_opportunity_outcomes
  for select to authenticated using (
    exists (
      select 1 from public.missed_opportunities opportunity
      where opportunity.id = opportunity_id
        and opportunity.user_id = (select auth.uid())
    )
  );
