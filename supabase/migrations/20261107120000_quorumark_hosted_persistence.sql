-- Hosted persistence and wallet identity bridge. Additive only.
alter table public.strategy_exchange_strategies
  add column if not exists cadence text not null default 'Every 4 hours';
alter table public.strategy_exchange_risk_policies
  add column if not exists max_loss numeric(18,2) not null default 250;
alter table public.strategy_exchange_versions
  add column if not exists backtest_id text;

create table if not exists public.wallet_identities (
  user_id uuid primary key references auth.users(id) on delete cascade,
  chain text not null,
  public_address text not null,
  created_at timestamptz not null default now(),
  unique (chain, public_address)
);

alter table public.wallet_identities enable row level security;
create policy "users see own wallet identities" on public.wallet_identities
  for select using (user_id = auth.uid());

create table if not exists public.strategy_exchange_paper_decisions (
  id text primary key,
  signal_id text not null,
  follower_id uuid not null references auth.users(id) on delete cascade,
  status text not null check (status in ('accepted', 'rejected')),
  reason_code text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (signal_id, follower_id)
);

create table if not exists public.strategy_exchange_paper_executions (
  id text primary key,
  idempotency_key text not null unique,
  decision_id text not null references public.strategy_exchange_paper_decisions(id) on delete cascade,
  follower_id uuid not null references auth.users(id) on delete cascade,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.strategy_exchange_paper_decisions enable row level security;
alter table public.strategy_exchange_paper_executions enable row level security;
create policy "followers see own paper decisions" on public.strategy_exchange_paper_decisions
  for select using (follower_id = auth.uid());
create policy "followers see own paper executions" on public.strategy_exchange_paper_executions
  for select using (follower_id = auth.uid());
