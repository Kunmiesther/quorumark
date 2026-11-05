-- Restore the user-owned safety limits expected by the Trust Center.
create table if not exists public.user_trading_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  max_order_size_usd numeric(18,2) not null default 25 check (max_order_size_usd >= 0),
  max_total_exposure_usd numeric(18,2) not null default 100 check (max_total_exposure_usd >= 0),
  daily_loss_limit_usd numeric(18,2) not null default 25 check (daily_loss_limit_usd >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_trading_limits enable row level security;

drop policy if exists "own_limits_select" on public.user_trading_limits;
create policy "own_limits_select"
on public.user_trading_limits for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "own_limits_insert" on public.user_trading_limits;
create policy "own_limits_insert"
on public.user_trading_limits for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "own_limits_update" on public.user_trading_limits;
create policy "own_limits_update"
on public.user_trading_limits for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "own_limits_delete" on public.user_trading_limits;
create policy "own_limits_delete"
on public.user_trading_limits for delete
to authenticated
using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.user_trading_limits to authenticated;
grant all on public.user_trading_limits to service_role;

drop trigger if exists user_trading_limits_updated_at on public.user_trading_limits;
create trigger user_trading_limits_updated_at
before update on public.user_trading_limits
for each row execute function public.update_updated_at_column();

-- Expose only the fields needed to assess the production worker. The base
-- table remains admin-only and worker identifiers and raw health details are
-- never returned to the browser.
create or replace function public.get_production_worker_health()
returns table (
  environment text,
  mode text,
  status text,
  last_seen_at timestamptz,
  credentials_ok boolean
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    w.environment,
    w.mode,
    w.status,
    w.last_seen_at,
    case
      when jsonb_typeof(w.health -> 'credentials_ok') = 'boolean'
        then (w.health ->> 'credentials_ok')::boolean
      else null
    end as credentials_ok
  from public.worker_heartbeats as w
  where (select auth.uid()) is not null
    and w.environment = 'production'
    and lower(w.mode) = 'live'
  order by w.last_seen_at desc, w.worker_id asc
  limit 1
$$;

revoke all on function public.get_production_worker_health() from public;
revoke all on function public.get_production_worker_health() from anon;
grant execute on function public.get_production_worker_health() to authenticated;
grant execute on function public.get_production_worker_health() to service_role;

comment on function public.get_production_worker_health() is
'Authenticated, read-only production worker health summary. Omits worker identity, version and raw health payload.';
