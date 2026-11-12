-- Durable owner-signing queue. The signer is never stored here; only the
-- commitment and retry state are persisted.
create table if not exists public.strategy_exchange_publication_jobs (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.strategy_exchange_strategies(id) on delete cascade,
  version_id uuid not null references public.strategy_exchange_versions(id) on delete cascade,
  commitment text not null check (commitment ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'processing', 'confirmed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  transaction_hash text,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(version_id)
);

create index if not exists publication_jobs_ready_idx
  on public.strategy_exchange_publication_jobs(status, next_attempt_at);

alter table public.strategy_exchange_publication_jobs enable row level security;

create policy "creators can see own publication jobs"
  on public.strategy_exchange_publication_jobs for select
  using (exists (
    select 1 from public.strategy_exchange_strategies s
    where s.id = strategy_id and s.creator_id = auth.uid()
  ));
