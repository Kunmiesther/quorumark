-- Browser wallets sign; the server stores immutable drafts and verifies chain receipts.
-- Users can read only their own records, and cannot manufacture confirmed fills.
create table public.blockchain_swap_intents (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  wallet_id uuid not null references public.wallet_connections(id),
  network text not null check (network in ('base', 'bnb')),
  action text not null check (action in ('approve', 'reset_approval', 'swap')),
  request jsonb not null,
  plan jsonb not null,
  status text not null default 'prepared'
    check (status in ('prepared', 'signing', 'submitted', 'confirmed', 'reverted', 'declined', 'cancelled')),
  tx_hash text check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  transaction_nonce text check (transaction_nonce ~ '^[0-9]+$'),
  hash_verified boolean not null default false,
  previous_hashes text[] not null default '{}',
  receipt jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index blockchain_swap_intents_owner_created
  on public.blockchain_swap_intents(user_id, created_at desc);
create index blockchain_swap_intents_wallet on public.blockchain_swap_intents(wallet_id);
create unique index blockchain_swap_intents_chain_hash
  on public.blockchain_swap_intents(user_id, network, tx_hash) where tx_hash is not null;
alter table public.blockchain_swap_intents enable row level security;
revoke all on public.blockchain_swap_intents from public, anon, authenticated;
grant select on public.blockchain_swap_intents to authenticated;
grant select, insert, update on public.blockchain_swap_intents to service_role;
create policy blockchain_swap_intents_read_own
  on public.blockchain_swap_intents for select to authenticated
  using ((select auth.uid()) = user_id);
