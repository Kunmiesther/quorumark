-- Restore the persistence contract, NOT lost order history. Deploy only after
-- historical/venue order reconciliation. Does not arm strategies, submit orders,
-- alter positions, or change exchange permissions. Never fabricate a fill.

do $$ begin
  if to_regtype('public.order_intent_state') is null then
    create type public.order_intent_state as enum (
      'previewed','confirmed','queued','signing','submitted','open',
      'partially_filled','filled','cancellation_pending','cancelled','rejected',
      'reconciliation_required','failed'
    );
  end if;
end $$;

-- Composite ownership prevents a trusted writer accidentally combining one
-- user's ID with another user's wallet/exchange connection.
create unique index if not exists exchange_connections_id_user_ledger_uidx
  on public.exchange_connections (id, user_id);

create table if not exists public.order_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  connection_id uuid not null references public.exchange_connections(id),
  client_order_id text not null,
  wallet_address text,
  environment text not null check (environment in ('mainnet','testnet')),
  venue text not null,
  symbol text not null,
  side text not null check (side in ('BUY','SELL')),
  order_type text not null check (order_type in ('LIMIT','MARKET')),
  size numeric not null check (size > 0 and size < 'Infinity'::numeric),
  protected_price numeric,
  mark_price_at_preview numeric,
  slippage_bps integer,
  max_fee numeric,
  expires_at timestamptz,
  reduce_only boolean not null default false,
  margin_mode text default 'cross',
  state public.order_intent_state not null default 'previewed',
  state_reason text,
  exchange_order_id text,
  exchange_status text,
  filled_size numeric not null default 0,
  avg_fill_price numeric,
  last_reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_order_id),
  foreign key (connection_id, user_id)
    references public.exchange_connections (id, user_id)
);
create index if not exists order_intents_user_state_idx
  on public.order_intents (user_id, state, created_at desc);
create index if not exists order_intents_connection_idx
  on public.order_intents (connection_id, created_at desc);
create index if not exists order_intents_reconcile_idx
  on public.order_intents (state, updated_at)
  where state in ('submitted','open','partially_filled','cancellation_pending','reconciliation_required');

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  connection_id uuid references public.exchange_connections(id),
  client_order_id text not null,
  exchange_order_id text,
  venue text,
  symbol text not null,
  side text not null,
  position_side text,
  strategy text not null,
  mode text not null default 'paper',
  requested_size numeric not null,
  filled_size numeric not null default 0,
  avg_price numeric,
  fee numeric,
  leverage numeric,
  resolved_max_leverage numeric,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (connection_id, user_id)
    references public.exchange_connections (id, user_id)
);
create unique index if not exists orders_conn_client_order_id_uniq
  on public.orders (connection_id, client_order_id);
create index if not exists orders_user_conn_idx
  on public.orders (user_id, connection_id);

create table if not exists public.order_audit (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid,
  connection_id uuid,
  idempotency_key text,
  phase text not null check (phase in ('received','validated','rejected','submitted','exchange_response')),
  venue text,
  symbol text,
  side text,
  order_type text,
  size numeric,
  price numeric,
  leverage numeric,
  is_live boolean,
  reject_reason text,
  exchange_order_id text,
  exchange_status text,
  sanitized_response jsonb
);
create index if not exists order_audit_user_created_idx
  on public.order_audit (user_id, created_at desc);
create unique index if not exists order_audit_idem_phase_uniq
  on public.order_audit (idempotency_key, phase) where idempotency_key is not null;

create or replace function public.order_audit_block_mutation()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'order_audit is append-only; % is not permitted', TG_OP;
end;
$$;
revoke all on function public.order_audit_block_mutation() from public, anon, authenticated;

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid='public.order_audit'::regclass
    and tgname='order_audit_no_update') then
    create trigger order_audit_no_update before update on public.order_audit
      for each row execute function public.order_audit_block_mutation();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid='public.order_audit'::regclass
    and tgname='order_audit_no_delete') then
    create trigger order_audit_no_delete before delete on public.order_audit
      for each row execute function public.order_audit_block_mutation();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid='public.order_intents'::regclass
    and tgname='update_order_intents_updated_at') then
    create trigger update_order_intents_updated_at before update on public.order_intents
      for each row execute function public.update_updated_at_column();
  end if;
end $$;

alter table public.order_intents enable row level security;
alter table public.orders enable row level security;
alter table public.order_audit enable row level security;
revoke all on public.order_intents, public.orders, public.order_audit from public, anon, authenticated;
grant select on public.order_intents, public.orders, public.order_audit to authenticated;
grant select, insert, update, delete on public.order_intents, public.orders to service_role;
revoke all on public.order_audit from service_role;
grant select, insert on public.order_audit to service_role;

do $$ declare table_name text; begin
  foreach table_name in array array['order_intents','orders','order_audit'] loop
    if not exists (select 1 from pg_policies where schemaname='public'
      and tablename=table_name and policyname='execution ledger owner read') then
      execute format('create policy "execution ledger owner read" on public.%I for select to authenticated using ((select auth.uid()) = user_id)', table_name);
    end if;
  end loop;
end $$;
