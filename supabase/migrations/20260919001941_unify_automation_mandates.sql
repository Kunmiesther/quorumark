-- Make an Onyx automation mandate the canonical owner of its executable
-- per-symbol strategy rows.  One user_strategy row represents one symbol;
-- active_bot_config must never fan that row back out across the symbol table.

alter table public.autopilot_workflows
  add column if not exists connection_id uuid references public.exchange_connections(id),
  add column if not exists symbols text[] not null
    default array['BTC-USDT','ETH-USDT','SOL-USDT','XRP-USDT']::text[],
  add column if not exists enabled_turtles text[] not null
    default array['accumulator']::text[],
  add column if not exists margin_pct numeric(5,2) not null default 5,
  add column if not exists rung_count smallint not null default 5,
  add column if not exists income_allocation_pct numeric(5,2) not null default 100;

alter table public.autopilot_workflows
  drop constraint if exists autopilot_workflows_symbols_check,
  add constraint autopilot_workflows_symbols_check check (
    cardinality(symbols) between 1 and 4
    and symbols <@ array['BTC-USDT','ETH-USDT','SOL-USDT','XRP-USDT']::text[]
  ),
  drop constraint if exists autopilot_workflows_enabled_turtles_check,
  add constraint autopilot_workflows_enabled_turtles_check check (
    cardinality(enabled_turtles) between 1 and 5
    and enabled_turtles <@ array['accumulator','vanguard','sniper','hunter','arbiter']::text[]
  ),
  drop constraint if exists autopilot_workflows_margin_pct_check,
  add constraint autopilot_workflows_margin_pct_check check (margin_pct = 5),
  drop constraint if exists autopilot_workflows_rung_count_check,
  add constraint autopilot_workflows_rung_count_check check (rung_count = 5),
  drop constraint if exists autopilot_workflows_income_allocation_pct_check,
  add constraint autopilot_workflows_income_allocation_pct_check
    check (income_allocation_pct = 100);

create index if not exists autopilot_workflows_connection_idx
  on public.autopilot_workflows (user_id, connection_id, updated_at desc);

comment on column public.autopilot_workflows.connection_id is
  'Verified venue selected by the owner for this mandate.';
comment on column public.autopilot_workflows.symbols is
  'The exact symbol scope materialized into user_strategy execution rows.';
comment on column public.autopilot_workflows.enabled_turtles is
  'Trading evaluators Onyx may route to. Scout remains reconnaissance and is not an execution Turtle.';
comment on column public.autopilot_workflows.margin_pct is
  'Dynamic per-campaign margin percentage applied to the current wallet balance.';
comment on column public.autopilot_workflows.rung_count is
  'Number of equal ladder rungs inside the dynamic margin allocation.';
comment on column public.autopilot_workflows.income_allocation_pct is
  'Percent of positive realized net P&L reserved toward Life Map bill coverage.';
comment on column public.autopilot_workflows.authorized_capital is
  'Owner-defined risk boundary. Position sizing is 5% of current wallet balance, subject to venue capacity; no app dollar ceiling is imposed.';

-- Production originally restored user_strategy with a legacy one-row-per-user
-- primary key.  A mandate needs one authoritative row per venue and symbol.
do $$
begin
  if exists (select 1 from public.user_strategy where connection_id is null) then
    raise exception 'Cannot enable per-symbol mandates while user_strategy contains unassigned venue rows';
  end if;
end $$;

alter table public.user_strategy
  alter column connection_id set not null;

alter table public.user_strategy
  drop constraint if exists user_strategy_connection_id_fkey,
  add constraint user_strategy_connection_id_fkey
    foreign key (connection_id) references public.exchange_connections(id) on delete cascade;

alter table public.user_strategy
  drop constraint if exists user_strategy_pkey,
  add constraint user_strategy_pkey primary key (user_id, connection_id, symbol);

create index if not exists user_strategy_workflow_idx
  on public.user_strategy ((params ->> 'autopilot_workflow_id'))
  where params ? 'autopilot_workflow_id';

create or replace view public.active_bot_config as
select
  us.user_id,
  ec.exchange as exchange_type,
  us.symbol,
  us.market_type::text as market_type,
  us.cross_margin,
  us.params,
  us.enabled,
  us.mode,
  ec.id as connection_id,
  ec.permission_trade,
  ec.permissions_verified,
  ec.environment,
  ec.status::text as status
from public.user_strategy us
join public.profiles p on p.id = us.user_id
join public.exchange_connections ec
  on ec.id = us.connection_id
 and ec.user_id = us.user_id;

revoke all on public.active_bot_config from public, authenticated, anon;
grant select on public.active_bot_config to service_role;
