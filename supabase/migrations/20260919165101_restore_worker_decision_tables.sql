-- Restore only the missing ledgers required by the deployed worker-ingest
-- handler. Existing paper trade constraints and data are intentionally untouched.
create table if not exists public.ops_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  correlation_id uuid not null,
  stage text not null check (stage in ('scout_scan','scout_envelope','onyx_decision','paper_intent','paper_execution','paper_fill','paper_outcome','watchdog','alert')),
  component text not null,
  severity text not null default 'info' check (severity in ('info','warn','error','critical')),
  message text not null,
  detail jsonb not null default '{}'::jsonb,
  latency_ms integer,
  server_ts timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists ops_events_corr_idx on public.ops_events (correlation_id, server_ts);
create index if not exists ops_events_user_ts_idx on public.ops_events (user_id, server_ts desc);
alter table public.ops_events enable row level security;
create policy "ops_events select own" on public.ops_events for select to authenticated
  using ((select auth.uid()) = user_id);
grant select on public.ops_events to authenticated;
grant all on public.ops_events to service_role;

create table if not exists public.onyx_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  correlation_id uuid not null,
  symbol text not null,
  side text not null check (side in ('long','short','flat')),
  decision text not null check (decision in ('open','add','close','hold','reject')),
  reject_reason text,
  strategy text,
  wallet_id uuid,
  confidence numeric,
  scan_id uuid,
  envelope_version integer not null,
  rules_version integer not null,
  supporting_codes text[] not null default '{}',
  conflicting_codes text[] not null default '{}',
  risk_check jsonb not null default '{}'::jsonb,
  signal_at timestamptz,
  decision_at timestamptz not null default now(),
  intent_at timestamptz,
  decision_latency_ms integer,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists onyx_decisions_user_ts_idx on public.onyx_decisions (user_id, decision_at desc);
create index if not exists onyx_decisions_corr_idx on public.onyx_decisions (correlation_id);
alter table public.onyx_decisions enable row level security;
create policy "onyx_decisions select own" on public.onyx_decisions for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "onyx_decisions insert own" on public.onyx_decisions for insert to authenticated
  with check ((select auth.uid()) = user_id);
grant select, insert on public.onyx_decisions to authenticated;
grant all on public.onyx_decisions to service_role;

create table if not exists public.scout_guardian_directives (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  position_id uuid not null references public.paper_positions(id) on delete cascade,
  wallet_key text,
  symbol text not null,
  directive_type text not null check (directive_type in
    ('cancel_unfilled_rungs','close_position','reduce_position','promote_runner',
     'cancel_fixed_tp','set_breakeven_stop','repair_stop')),
  reason_code text not null,
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','consumed','expired','superseded')),
  correlation_id uuid,
  guardian_cycle_ts_ms bigint,
  created_at timestamptz not null default now(),
  consumed_at timestamptz,
  consumed_by text
);
create unique index if not exists scout_guardian_directives_pending_uniq
  on public.scout_guardian_directives (position_id, directive_type) where status = 'pending';
create index if not exists scout_guardian_directives_user_status_idx
  on public.scout_guardian_directives (user_id, status, created_at);
alter table public.scout_guardian_directives enable row level security;
create policy "scout_guardian_directives select own" on public.scout_guardian_directives
  for select to authenticated using ((select auth.uid()) = user_id);
grant select on public.scout_guardian_directives to authenticated;
grant all on public.scout_guardian_directives to service_role;

create table if not exists public.paper_live_shadow_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  observed_at timestamptz not null default now(),
  symbol text not null,
  leg text not null,
  direction text not null check (direction in ('long','short')),
  regime text,
  trend_age_candles integer,
  directive_type text not null,
  paper_decision jsonb,
  live_decision jsonb,
  paper_price numeric,
  live_price numeric,
  price_delta_bps numeric,
  comparison_status text not null default 'paper_only'
    check (comparison_status in ('paper_only','live_only','in_line','divergent')),
  divergence_reason text,
  notes jsonb not null default '{}'::jsonb,
  constraint shadow_decision_present check (paper_decision is not null or live_decision is not null)
);
create index if not exists paper_live_shadow_ledger_user_time_idx
  on public.paper_live_shadow_ledger (user_id, observed_at desc);
alter table public.paper_live_shadow_ledger enable row level security;
create policy "shadow_ledger_owner_read" on public.paper_live_shadow_ledger
  for select to authenticated using ((select auth.uid()) = user_id);
grant select on public.paper_live_shadow_ledger to authenticated;
grant all on public.paper_live_shadow_ledger to service_role;

create table if not exists public.strategy_decisions (
  decision_id text primary key,
  user_id uuid not null,
  connection_id uuid not null,
  symbol text not null,
  strategy text not null,
  armed_leg text,
  timeframe text not null default '15m',
  candle_close_at timestamptz not null,
  direction text not null check (direction in ('long','short','wait')),
  reason_code text not null,
  reason text not null default '',
  entry_zone jsonb,
  invalidation numeric,
  take_profits jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  evidence_hash text not null,
  schema_version text not null default 'decision.v1',
  execution_state text not null default 'not_reached' check (execution_state in
    ('not_reached','blocked','intent_created','submitted','ambiguous','rejected','filled')),
  execution_reason_code text,
  safety_checks jsonb,
  order_intent jsonb,
  apex_result jsonb,
  execution_updated_at timestamptz,
  trace_id uuid,
  terminal_outcome text check (terminal_outcome is null or terminal_outcome in
    ('TRADE_CANDIDATE','NO_TRADE_STRATEGY','NO_TRADE_RISK','PIPELINE_ERROR')),
  terminal_reason text,
  terminal_at timestamptz,
  risk_check jsonb,
  simulated_intent jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint strategy_decisions_one_per_candle unique (connection_id, symbol, candle_close_at)
);
create index if not exists strategy_decisions_symbol_candle_idx
  on public.strategy_decisions (user_id, symbol, candle_close_at desc);
alter table public.strategy_decisions enable row level security;
create policy "Owners read their own decisions" on public.strategy_decisions
  for select to authenticated using ((select auth.uid()) = user_id);
grant select on public.strategy_decisions to authenticated;
grant all on public.strategy_decisions to service_role;

create or replace function public.strategy_decisions_guard()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.decision_id is distinct from old.decision_id
     or new.user_id is distinct from old.user_id
     or new.connection_id is distinct from old.connection_id
     or new.symbol is distinct from old.symbol
     or new.candle_close_at is distinct from old.candle_close_at
     or new.direction is distinct from old.direction
     or new.reason_code is distinct from old.reason_code
     or new.evidence_hash is distinct from old.evidence_hash then
    raise exception 'strategy_decisions: decision fields are immutable';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.strategy_decisions_guard() from public, anon, authenticated;
create trigger strategy_decisions_guard_trg before update on public.strategy_decisions
  for each row execute function public.strategy_decisions_guard();
