-- Restore the production exchange credential schema expected by the deployed
-- exchange-credentials Edge Function and Trust Center. The replacement
-- project retained only the original exchange_connections table shape.

alter table public.exchange_connections
  add column if not exists display_name text,
  add column if not exists environment text not null default 'production',
  add column if not exists permissions_verified boolean not null default false,
  add column if not exists permission_verified_at timestamptz,
  add column if not exists permission_scopes jsonb not null default '{}'::jsonb,
  add column if not exists last_verified_at timestamptz,
  add column if not exists last_health_check_at timestamptz,
  add column if not exists last_error_code text,
  add column if not exists last_error_message text,
  add column if not exists market_type public.account_mode not null default 'futures',
  add column if not exists is_live boolean not null default false;

update public.exchange_connections
   set last_error_message = last_error
 where last_error is not null
   and last_error_message is null;

-- A connection is untrusted until the server verifies its scopes.
alter table public.exchange_connections
  alter column permission_read set default false,
  alter column permission_trade set default false;

-- These legacy fields were never compatible with the current encrypted
-- credential envelope. Production has no connection rows, so removing them
-- cannot discard a saved credential.
alter table public.exchange_connections
  drop column if exists api_key_encrypted,
  drop column if exists api_secret_encrypted;

create index if not exists exchange_connections_permission_verified_at_idx
  on public.exchange_connections (permission_verified_at);

create table if not exists public.exchange_credentials (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null unique
    references public.exchange_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  encrypted_api_key text not null,
  encrypted_api_secret text not null,
  encrypted_passphrase text,
  encrypted_omni_seed text,
  encryption_version integer not null default 1,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

alter table public.exchange_credentials enable row level security;
revoke all on public.exchange_credentials from public, anon, authenticated;
grant all on public.exchange_credentials to service_role;

-- Connection creation, replacement and deletion remain server-only. The one
-- direct client mutation is the owner's explicit live-mode toggle.
drop policy if exists "Users insert own connections" on public.exchange_connections;
drop policy if exists "Users update own connections" on public.exchange_connections;
drop policy if exists "Users delete own connections" on public.exchange_connections;
drop policy if exists "Users update own connection live flag" on public.exchange_connections;

revoke insert, update, delete on public.exchange_connections from authenticated;
grant select on public.exchange_connections to authenticated;
grant update (is_live) on public.exchange_connections to authenticated;
grant all on public.exchange_connections to service_role;

drop policy if exists "Users view own connections" on public.exchange_connections;
create policy "Users view own connections"
  on public.exchange_connections
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users update own connection live flag"
  on public.exchange_connections
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- The Trust Center joins this sanitized status surface after a connection is
-- saved. The encrypted signing bundle is never granted to the client role.
create table if not exists public.apex_execution_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  exchange_connection_id uuid not null
    references public.exchange_connections(id) on delete cascade,
  environment text not null check (environment in ('mainnet', 'testnet')),
  wallet_address text not null,
  apex_account_id text,
  encrypted_credentials text not null,
  encryption_key_version integer not null default 1,
  credential_fingerprint text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  last_verified_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index if not exists apex_execution_credentials_one_active
  on public.apex_execution_credentials
    (user_id, wallet_address, exchange_connection_id, environment)
  where active = true and revoked_at is null;

alter table public.apex_execution_credentials enable row level security;
revoke all on public.apex_execution_credentials from public, anon, authenticated;
grant all on public.apex_execution_credentials to service_role;
grant select (
  id, user_id, exchange_connection_id, environment, wallet_address,
  apex_account_id, encryption_key_version, credential_fingerprint, active,
  created_at, rotated_at, revoked_at, last_verified_at, updated_at
) on public.apex_execution_credentials to authenticated;

drop policy if exists "Users view own Apex execution credential status"
  on public.apex_execution_credentials;
create policy "Users view own Apex execution credential status"
  on public.apex_execution_credentials
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create or replace view public.apex_execution_credentials_status
with (security_invoker = true) as
select
  id,
  user_id,
  exchange_connection_id,
  environment,
  wallet_address,
  apex_account_id,
  encryption_key_version,
  credential_fingerprint,
  active,
  created_at,
  rotated_at,
  revoked_at,
  last_verified_at
from public.apex_execution_credentials
where user_id = (select auth.uid());

revoke all on public.apex_execution_credentials_status from public, anon;
grant select on public.apex_execution_credentials_status to authenticated;

-- Transactional schema smoke test. No credential material or test row remains.
do $$
declare
  smoke_user uuid;
  smoke_connection uuid;
begin
  select id into smoke_user from auth.users order by created_at limit 1;
  if smoke_user is null then
    raise exception 'exchange credential smoke test requires an auth user';
  end if;

  insert into public.exchange_connections (
    user_id, exchange, environment, status, withdrawals_disabled
  ) values (
    smoke_user, '__schema_smoke__', 'production',
    'pending_verification', true
  ) returning id into smoke_connection;

  insert into public.exchange_credentials (
    connection_id, user_id, encrypted_api_key, encrypted_api_secret,
    encrypted_passphrase, encryption_version
  ) values (
    smoke_connection, smoke_user, 'v1:test:test', 'v1:test:test',
    'v1:test:test', 1
  );

  if not exists (
    select 1 from public.exchange_credentials
     where connection_id = smoke_connection and user_id = smoke_user
  ) then
    raise exception 'exchange credential schema smoke test failed';
  end if;

  delete from public.exchange_connections where id = smoke_connection;
end
$$;
