-- Quorumark paper engine records. These tables are intentionally separate from
-- any legacy execution or signer tables and never authorize live orders.
create table if not exists public.strategy_exchange_backtest_runs (
  id text primary key,
  creator_id uuid references auth.users(id),
  strategy_version_id uuid references public.strategy_exchange_versions(id),
  evidence_class text not null default 'backtested' check (evidence_class = 'backtested'),
  data_source text not null,
  payload jsonb not null,
  evidence_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.strategy_exchange_paper_positions (
  id text primary key,
  follower_id uuid not null references auth.users(id),
  strategy_id uuid references public.strategy_exchange_strategies(id),
  signal_id uuid references public.strategy_exchange_signals(id),
  asset text not null,
  side text not null check (side in ('long', 'short')),
  quantity numeric(30,12) not null check (quantity > 0),
  entry_price numeric(30,12) not null check (entry_price > 0),
  exit_price numeric(30,12),
  status text not null default 'open' check (status in ('open', 'closed')),
  realized_pnl numeric(30,12) not null default 0,
  unrealized_pnl numeric(30,12) not null default 0,
  fees numeric(30,12) not null default 0,
  evidence_class text not null default 'paper_traded' check (evidence_class = 'paper_traded'),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists public.strategy_exchange_paper_evidence (
  id uuid primary key default gen_random_uuid(),
  follower_id uuid not null references auth.users(id),
  signal_id uuid references public.strategy_exchange_signals(id),
  decision_id uuid references public.strategy_exchange_decisions(id),
  execution_id uuid references public.strategy_exchange_executions(id),
  idempotency_key text not null unique,
  evidence_hash text not null,
  payload jsonb not null,
  evidence_class text not null check (evidence_class in ('backtested', 'paper_traded', 'near_testnet')),
  created_at timestamptz not null default now()
);

create index if not exists strategy_exchange_paper_positions_follower_idx
  on public.strategy_exchange_paper_positions(follower_id, created_at desc);
create index if not exists strategy_exchange_backtest_runs_creator_idx
  on public.strategy_exchange_backtest_runs(creator_id, created_at desc);

alter table public.strategy_exchange_backtest_runs enable row level security;
alter table public.strategy_exchange_paper_positions enable row level security;
alter table public.strategy_exchange_paper_evidence enable row level security;

create policy "creators see own backtests" on public.strategy_exchange_backtest_runs
  for select using (creator_id = auth.uid());
create policy "followers see own paper positions" on public.strategy_exchange_paper_positions
  for select using (follower_id = auth.uid());
create policy "followers see own paper evidence" on public.strategy_exchange_paper_evidence
  for select using (follower_id = auth.uid());
