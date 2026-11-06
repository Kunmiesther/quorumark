create table if not exists public.wallet_connection_challenges (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  chain text not null,
  public_address text not null,
  nonce_hash text not null unique,
  challenge_text text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.wallet_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  provider text not null,
  chain text not null,
  network text not null default 'testnet',
  public_address text not null,
  label text,
  status text not null default 'verified' check (status in ('verified', 'disconnected')),
  is_active boolean not null default false,
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (chain, public_address)
);

create index if not exists wallet_connection_challenges_expiry_idx
  on public.wallet_connection_challenges (expires_at);
create index if not exists wallet_connections_user_idx
  on public.wallet_connections (user_id, created_at desc);

alter table public.wallet_connection_challenges enable row level security;
alter table public.wallet_connections enable row level security;

-- Edge Functions use the service role for challenge consumption and signature verification.
-- Client-side reads are intentionally not exposed through policies.
