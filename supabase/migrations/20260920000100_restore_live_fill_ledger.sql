-- Restore the deployed ApeX fill reconciler's missing persistence contract.
-- This migration creates ledgers and adds nullable attribution columns only;
-- it neither changes positions nor backfills an unprovable venue identity.

create table if not exists public.live_fills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.exchange_connections(id) on delete restrict,
  venue text not null default 'apex_omni',
  venue_fill_id text not null,
  venue_order_id text,
  symbol text not null,
  side text not null check (side in ('BUY', 'SELL')),
  price numeric(30,10) not null,
  size numeric(30,10) not null check (size > 0),
  fee numeric(30,10) not null default 0,
  fee_currency text,
  liquidity text,
  fill_ts timestamptz not null,
  residual_size numeric(30,10) not null,
  matched_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists live_fills_conn_venue_fill_uidx
  on public.live_fills (connection_id, venue_fill_id);
create index if not exists live_fills_matcher_idx
  on public.live_fills (connection_id, symbol, fill_ts) where residual_size > 0;
create index if not exists live_fills_user_conn_idx
  on public.live_fills (user_id, connection_id, fill_ts desc);

alter table public.live_fills enable row level security;
grant select on public.live_fills to authenticated;
grant all on public.live_fills to service_role;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
    and tablename = 'live_fills' and policyname = 'live_fills owner read') then
    create policy "live_fills owner read" on public.live_fills
      for select to authenticated using ((select auth.uid()) = user_id);
  end if;
end $$;

create table if not exists public.live_fills_cursor (
  connection_id uuid primary key references public.exchange_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_fill_id text,
  last_fill_ts timestamptz,
  last_polled_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists live_fills_cursor_user_idx
  on public.live_fills_cursor (user_id);

alter table public.live_fills_cursor enable row level security;
grant select on public.live_fills_cursor to authenticated;
grant all on public.live_fills_cursor to service_role;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
    and tablename = 'live_fills_cursor' and policyname = 'live_fills_cursor owner read') then
    create policy "live_fills_cursor owner read" on public.live_fills_cursor
      for select to authenticated using ((select auth.uid()) = user_id);
  end if;
end $$;

alter table public.trades
  add column if not exists connection_id uuid,
  add column if not exists venue text,
  add column if not exists venue_order_id text,
  add column if not exists entry_venue_fill_id text,
  add column if not exists exit_venue_fill_id text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'trades_connection_id_fkey'
    and conrelid = 'public.trades'::regclass) then
    alter table public.trades add constraint trades_connection_id_fkey
      foreign key (connection_id) references public.exchange_connections(id) on delete restrict;
  end if;
end $$;

create unique index if not exists trades_conn_exit_fill_uidx
  on public.trades (connection_id, exit_venue_fill_id)
  where exit_venue_fill_id is not null;
create index if not exists trades_user_conn_idx
  on public.trades (user_id, connection_id);
