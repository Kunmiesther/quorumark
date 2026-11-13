-- Durable autonomous evaluation ledger. The backend service role writes these
-- records; followers only receive signals through active subscriptions.
create table if not exists public.strategy_exchange_evaluations (
  id text primary key,
  strategy_id uuid not null references public.strategy_exchange_strategies(id) on delete cascade,
  version_id uuid not null references public.strategy_exchange_versions(id) on delete cascade,
  observation_key text not null unique,
  decision text not null check (decision in ('BUY','SELL','HOLD','NO_ACTION')),
  status text not null check (status in ('completed','failed','stale')),
  source text not null,
  candle_timestamp timestamptz not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists strategy_exchange_evaluations_strategy_idx
  on public.strategy_exchange_evaluations(strategy_id, created_at desc);
alter table public.strategy_exchange_evaluations enable row level security;
create policy "creators see own autonomous evaluations" on public.strategy_exchange_evaluations
  for select using (exists (
    select 1 from public.strategy_exchange_strategies s
    where s.id = strategy_id and s.creator_id = auth.uid()
  ));
create policy "active followers see subscribed autonomous evaluations" on public.strategy_exchange_evaluations
  for select using (exists (
    select 1 from public.strategy_exchange_subscriptions sub
    where sub.strategy_id = strategy_exchange_evaluations.strategy_id
      and sub.follower_id = auth.uid() and sub.status = 'active'
      and (sub.expires_at is null or sub.expires_at > now())
  ));
