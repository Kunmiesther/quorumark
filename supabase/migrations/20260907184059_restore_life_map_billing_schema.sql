-- Restore the Life Map billing foundation that exists in the application
-- contract but was absent from the production database migration history.

create table if not exists public.bills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  amount_usd numeric(12, 2) not null check (amount_usd > 0),
  cadence text not null check (cadence in ('monthly', 'weekly', 'one_time')),
  due_day integer,
  priority integer not null default 100,
  category text,
  assigned_strategy text,
  paid_at timestamptz,
  proof_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index if not exists bills_user_active_idx
  on public.bills (user_id, priority, created_at)
  where archived_at is null;

create index if not exists bills_user_category_idx
  on public.bills (user_id, category)
  where archived_at is null;

alter table public.bills enable row level security;
revoke all on table public.bills from anon;
grant select, insert, update, delete on table public.bills to authenticated;
grant all on table public.bills to service_role;

drop policy if exists "bills owner read" on public.bills;
create policy "bills owner read"
  on public.bills for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "bills owner insert" on public.bills;
create policy "bills owner insert"
  on public.bills for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "bills owner update" on public.bills;
create policy "bills owner update"
  on public.bills for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "bills owner delete" on public.bills;
create policy "bills owner delete"
  on public.bills for delete to authenticated
  using ((select auth.uid()) = user_id);

create table if not exists public.bill_allocations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  bill_id uuid not null references public.bills(id) on delete cascade,
  trade_id uuid,
  amount_usd numeric(14, 4) not null,
  period_key text not null check (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  source text not null default 'paper'
    check (source in ('paper', 'live', 'reallocation')),
  created_at timestamptz not null default now()
);

create unique index if not exists bill_allocations_trade_bill_uidx
  on public.bill_allocations (user_id, source, trade_id, bill_id)
  where trade_id is not null;
create index if not exists bill_allocations_bill_period_idx
  on public.bill_allocations (bill_id, period_key);
create index if not exists bill_allocations_user_period_idx
  on public.bill_allocations (user_id, period_key);
create index if not exists bill_allocations_user_source_period_idx
  on public.bill_allocations (user_id, source, period_key);

alter table public.bill_allocations enable row level security;
revoke all on table public.bill_allocations from anon;
grant select, insert, update, delete on table public.bill_allocations to authenticated;
grant all on table public.bill_allocations to service_role;

drop policy if exists "bill_allocations owner read" on public.bill_allocations;
create policy "bill_allocations owner read"
  on public.bill_allocations for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "bill_allocations owner insert" on public.bill_allocations;
create policy "bill_allocations owner insert"
  on public.bill_allocations for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "bill_allocations owner update" on public.bill_allocations;
create policy "bill_allocations owner update"
  on public.bill_allocations for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "bill_allocations owner delete" on public.bill_allocations;
create policy "bill_allocations owner delete"
  on public.bill_allocations for delete to authenticated
  using ((select auth.uid()) = user_id);

create table if not exists public.bill_sync_cursor (
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null default 'paper' check (source in ('paper', 'live')),
  last_trade_closed_at timestamptz,
  last_trade_id uuid,
  updated_at timestamptz not null default now(),
  primary key (user_id, source)
);

alter table public.bill_sync_cursor enable row level security;
revoke all on table public.bill_sync_cursor from anon;
grant select, insert, update, delete on table public.bill_sync_cursor to authenticated;
grant all on table public.bill_sync_cursor to service_role;

drop policy if exists "bill_sync_cursor owner read" on public.bill_sync_cursor;
create policy "bill_sync_cursor owner read"
  on public.bill_sync_cursor for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "bill_sync_cursor owner insert" on public.bill_sync_cursor;
create policy "bill_sync_cursor owner insert"
  on public.bill_sync_cursor for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "bill_sync_cursor owner update" on public.bill_sync_cursor;
create policy "bill_sync_cursor owner update"
  on public.bill_sync_cursor for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter table public.profiles
  add column if not exists bills_prompt_dismissed_at timestamptz;

create or replace function public.bills_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.bills_touch_updated_at() from public, anon;
grant execute on function public.bills_touch_updated_at() to authenticated, service_role;

drop trigger if exists bills_touch_updated_at on public.bills;
create trigger bills_touch_updated_at
  before update on public.bills
  for each row execute function public.bills_touch_updated_at();

drop trigger if exists bill_sync_cursor_touch_updated_at on public.bill_sync_cursor;
create trigger bill_sync_cursor_touch_updated_at
  before update on public.bill_sync_cursor
  for each row execute function public.bills_touch_updated_at();

notify pgrst, 'reload schema';
