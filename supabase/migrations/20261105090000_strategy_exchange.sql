create table if not exists public.strategy_exchange_strategies (
  id uuid primary key default gen_random_uuid(), creator_id uuid not null references auth.users(id) on delete cascade,
  slug text not null unique, name text not null, thesis text not null, status text not null default 'draft' check (status in ('draft','published','paused')),
  supported_assets text[] not null default '{}', market text not null, risk_class text not null, current_version text not null default 'v1.0',
  evidence_class text not null default 'backtested' check (evidence_class in ('backtested','paper_traded','testnet_executed','live_verified')),
  monthly_price numeric(18,2) not null default 0 check (monthly_price >= 0), created_at timestamptz not null default now(), published_at timestamptz
);
create table if not exists public.strategy_exchange_versions (
  id uuid primary key default gen_random_uuid(), strategy_id uuid not null references public.strategy_exchange_strategies(id) on delete cascade,
  version text not null, definition jsonb not null, backtest_metrics jsonb, content_hash text, created_at timestamptz not null default now(), unique(strategy_id, version)
);
create table if not exists public.strategy_exchange_subscriptions (
  id uuid primary key default gen_random_uuid(), strategy_id uuid not null references public.strategy_exchange_strategies(id) on delete cascade,
  follower_id uuid not null references auth.users(id) on delete cascade, status text not null default 'pending' check (status in ('pending','active','cancelled','expired')),
  environment text not null default 'sandbox' check (environment in ('sandbox','near_testnet')), receipt jsonb, starts_at timestamptz, expires_at timestamptz, created_at timestamptz not null default now(), unique(strategy_id, follower_id)
);
create table if not exists public.strategy_exchange_signals (
  id uuid primary key default gen_random_uuid(), strategy_id uuid not null references public.strategy_exchange_strategies(id) on delete cascade,
  version_id uuid not null references public.strategy_exchange_versions(id), payload jsonb not null, created_at timestamptz not null default now(), unique(strategy_id, id)
);
create table if not exists public.strategy_exchange_risk_policies (
  follower_id uuid primary key references auth.users(id) on delete cascade, capital numeric(18,2) not null default 10000, max_trade numeric(18,2) not null default 1500,
  max_position numeric(18,2) not null default 2500, max_slippage_bps integer not null default 30, approved_assets text[] not null default '{}', paused boolean not null default false, updated_at timestamptz not null default now()
);
create table if not exists public.strategy_exchange_decisions (
  id uuid primary key default gen_random_uuid(), signal_id uuid not null references public.strategy_exchange_signals(id), follower_id uuid not null references auth.users(id), status text not null check (status in ('accepted','rejected')),
  reason text not null, notional numeric(18,2) not null default 0, created_at timestamptz not null default now(), unique(signal_id, follower_id)
);
create table if not exists public.strategy_exchange_executions (
  id uuid primary key default gen_random_uuid(), decision_id uuid not null unique references public.strategy_exchange_decisions(id), follower_id uuid not null references auth.users(id),
  environment text not null default 'paper' check (environment in ('paper','near_testnet')), asset text not null, side text not null, notional numeric(18,2) not null,
  entry_price numeric(30,10) not null, exit_price numeric(30,10), realized_pnl numeric(18,2), fees numeric(18,2) not null default 0, evidence_class text not null default 'paper_traded', receipt jsonb, created_at timestamptz not null default now()
);
create index if not exists strategy_exchange_signals_strategy_created on public.strategy_exchange_signals(strategy_id, created_at desc);
create index if not exists strategy_exchange_executions_follower_created on public.strategy_exchange_executions(follower_id, created_at desc);
alter table public.strategy_exchange_strategies enable row level security;
alter table public.strategy_exchange_versions enable row level security;
alter table public.strategy_exchange_subscriptions enable row level security;
alter table public.strategy_exchange_signals enable row level security;
alter table public.strategy_exchange_risk_policies enable row level security;
alter table public.strategy_exchange_decisions enable row level security;
alter table public.strategy_exchange_executions enable row level security;
create policy "published strategies are discoverable" on public.strategy_exchange_strategies for select using (status = 'published' or creator_id = auth.uid());
create policy "creators manage own strategies" on public.strategy_exchange_strategies for all using (creator_id = auth.uid()) with check (creator_id = auth.uid());
create policy "creator versions are private" on public.strategy_exchange_versions for all using (exists (select 1 from public.strategy_exchange_strategies s where s.id = strategy_id and s.creator_id = auth.uid()));
create policy "followers see own subscriptions" on public.strategy_exchange_subscriptions for select using (follower_id = auth.uid());
create policy "followers manage own policy" on public.strategy_exchange_risk_policies for all using (follower_id = auth.uid()) with check (follower_id = auth.uid());
create policy "followers see own decisions" on public.strategy_exchange_decisions for select using (follower_id = auth.uid());
create policy "followers see own executions" on public.strategy_exchange_executions for select using (follower_id = auth.uid());
