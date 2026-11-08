-- Additive publication evidence ledger. The strategy/version remains the
-- source of truth; this table records an optional, independently verifiable
-- NEAR testnet anchor without storing private strategy parameters.
create table if not exists public.strategy_exchange_publication_evidence (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.strategy_exchange_strategies(id) on delete cascade,
  version_id uuid not null references public.strategy_exchange_versions(id) on delete cascade,
  creator_near_account text not null,
  commitment text not null check (commitment ~ '^[0-9a-f]{64}$'),
  schema_version text not null check (schema_version = 'quorumark.publication.v1'),
  network text not null check (network = 'near:testnet'),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'failed', 'rejected')),
  transaction_hash text,
  transaction_receiver text,
  block_height bigint,
  receipt jsonb,
  requested_at timestamptz not null default now(),
  confirmed_at timestamptz,
  unique (version_id),
  unique (network, transaction_hash)
);

create index if not exists publication_evidence_strategy_idx
  on public.strategy_exchange_publication_evidence(strategy_id, requested_at desc);

alter table public.strategy_exchange_publication_evidence enable row level security;

create policy "published publication evidence is public"
  on public.strategy_exchange_publication_evidence for select
  using (exists (
    select 1 from public.strategy_exchange_strategies s
    where s.id = strategy_id and s.status = 'published'
  ));

create policy "creators see own publication evidence"
  on public.strategy_exchange_publication_evidence for select
  using (exists (
    select 1 from public.strategy_exchange_strategies s
    where s.id = strategy_id and s.creator_id = auth.uid()
  ));
