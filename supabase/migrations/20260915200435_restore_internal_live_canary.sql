-- Restore the minimum production schema required by the owner-only manual
-- ApeX live canary. Additive and idempotent: no user data is deleted and no
-- public/community account is granted live execution.

-- user_strategy in production still has its original five-column shape.
-- Add the runtime columns used by onboarding/status without changing its
-- existing primary key or multiplying strategy rows.
alter table public.user_strategy
  add column if not exists connection_id uuid,
  add column if not exists symbol text not null default 'BTC-USDT',
  add column if not exists enabled boolean not null default false,
  add column if not exists mode text not null default 'paper',
  add column if not exists params jsonb not null default '{}'::jsonb,
  add column if not exists hedge_guard jsonb not null default '{}'::jsonb,
  add column if not exists margin_mode text default 'cross',
  add column if not exists capability_reconciliation_required boolean not null default false;

alter table public.user_strategy alter column cross_margin set default true;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_strategy_connection_id_fkey'
      and conrelid = 'public.user_strategy'::regclass
  ) then
    alter table public.user_strategy
      add constraint user_strategy_connection_id_fkey
      foreign key (connection_id)
      references public.exchange_connections(id)
      on delete set null;
  end if;
end $$;

create index if not exists user_strategy_user_connection_idx
  on public.user_strategy (user_id, connection_id);

-- Attach legacy one-row strategy records to the owner's newest verified
-- ApeX connection. This is ownership-preserving and only fills NULL values.
with latest_owned_apex as (
  select distinct on (ec.user_id) ec.user_id, ec.id
  from public.exchange_connections ec
  where ec.exchange = 'apex_omni'
    and ec.status::text = 'verified'
  order by ec.user_id, ec.last_verified_at desc nulls last, ec.created_at desc, ec.id
)
update public.user_strategy us
set connection_id = picked.id,
    cross_margin = true,
    margin_mode = 'cross',
    updated_at = now()
from latest_owned_apex picked
where us.user_id = picked.user_id
  and us.connection_id is null;

-- Recover an already-verified internal/admin activation. The predicates are
-- deliberately conjunctive: admin role + live connection + verified trade
-- permission + active encrypted signer credential.
update public.user_strategy us
set enabled = true,
    mode = 'live',
    cross_margin = true,
    margin_mode = 'cross',
    updated_at = now()
from public.exchange_connections ec
where ec.id = us.connection_id
  and ec.user_id = us.user_id
  and ec.exchange = 'apex_omni'
  and ec.environment in ('production', 'mainnet')
  and ec.status::text = 'verified'
  and ec.permission_trade is true
  and ec.permissions_verified is true
  and ec.is_live is true
  and exists (
    select 1
    from public.user_roles ur
    where ur.user_id = us.user_id
      and ur.role::text = 'admin'
  )
  and exists (
    select 1
    from public.apex_execution_credentials aec
    where aec.user_id = us.user_id
      and aec.exchange_connection_id = ec.id
      and aec.active is true
      and aec.revoked_at is null
  );

alter table public.user_strategy enable row level security;
drop policy if exists "Users manage own strategy" on public.user_strategy;
create policy "Users manage own strategy"
on public.user_strategy
for all
to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and (
    connection_id is null
    or exists (
      select 1
      from public.exchange_connections ec
      where ec.id = connection_id
        and ec.user_id = (select auth.uid())
    )
  )
);

grant select, insert, update, delete on public.user_strategy to authenticated;
grant all on public.user_strategy to service_role;

-- Authoritative global/user/connection emergency stop. Clients can read
-- their own state but cannot write switches; only service_role can mutate.
create table if not exists public.kill_switches (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('global', 'user', 'connection')),
  user_id uuid references auth.users(id) on delete cascade,
  connection_id uuid references public.exchange_connections(id) on delete cascade,
  active boolean not null default true,
  reason text,
  updated_at timestamptz not null default now(),
  constraint kill_switches_scope_shape check (
    (scope = 'global' and user_id is null and connection_id is null)
    or (scope = 'user' and user_id is not null and connection_id is null)
    or (scope = 'connection' and user_id is not null and connection_id is not null)
  )
);

create unique index if not exists kill_switches_one_global
  on public.kill_switches ((true)) where scope = 'global';
create unique index if not exists kill_switches_one_per_user
  on public.kill_switches (user_id) where scope = 'user';
create unique index if not exists kill_switches_one_per_connection
  on public.kill_switches (connection_id) where scope = 'connection';

alter table public.kill_switches enable row level security;
drop policy if exists "Users can view own or global kill switches" on public.kill_switches;
create policy "Users can view own or global kill switches"
on public.kill_switches
for select
to authenticated
using (
  (scope in ('user', 'connection') and user_id = (select auth.uid()))
  or public.has_role((select auth.uid()), 'admin')
);

revoke all on public.kill_switches from public, anon, authenticated;
grant select on public.kill_switches to authenticated;
grant all on public.kill_switches to service_role;

drop trigger if exists kill_switches_updated_at on public.kill_switches;
create trigger kill_switches_updated_at
before update on public.kill_switches
for each row execute function public.update_updated_at_column();

-- Fail closed on NULL identity, spoofed identity, or a connection not owned by
-- the requested user. Authenticated callers may query only their own status.
create or replace function public.is_execution_halted(
  p_user_id uuid,
  p_connection_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_user_id is null then true
    when auth.uid() is not null and auth.uid() <> p_user_id then true
    when p_connection_id is not null and not exists (
      select 1
      from public.exchange_connections ec
      where ec.id = p_connection_id
        and ec.user_id = p_user_id
    ) then true
    else exists (
      select 1
      from public.kill_switches ks
      where ks.active is true
        and (
          ks.scope = 'global'
          or (ks.scope = 'user' and ks.user_id = p_user_id)
          or (
            ks.scope = 'connection'
            and ks.user_id = p_user_id
            and ks.connection_id = p_connection_id
          )
        )
    )
  end
$$;

revoke all on function public.is_execution_halted(uuid, uuid) from public, anon;
grant execute on function public.is_execution_halted(uuid, uuid) to authenticated, service_role;

comment on function public.is_execution_halted(uuid, uuid) is
'Fail-closed execution stop check used by the authenticated Railway broker and private signer.';
