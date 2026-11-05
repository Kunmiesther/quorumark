-- Give every live position and closed trade a normalized ownership spine.
-- The JSON strategy_metadata remains the audit snapshot, while these nullable
-- foreign keys make wallet / mandate / strategy / decision attribution
-- queryable and prevent the UI from inferring ownership from display names.

alter table public.positions
  add column if not exists wallet_connection_id uuid
    references public.wallet_connections(id) on delete set null,
  add column if not exists autopilot_workflow_id uuid
    references public.autopilot_workflows(id) on delete set null,
  add column if not exists strategy_id uuid
    references public.strategies(id) on delete set null,
  add column if not exists decision_id text
    references public.strategy_decisions(decision_id) on delete set null;

alter table public.trades
  add column if not exists wallet_connection_id uuid
    references public.wallet_connections(id) on delete set null,
  add column if not exists autopilot_workflow_id uuid
    references public.autopilot_workflows(id) on delete set null,
  add column if not exists decision_id text
    references public.strategy_decisions(decision_id) on delete set null;

create index if not exists positions_live_attribution_idx
  on public.positions (user_id, connection_id, autopilot_workflow_id, strategy_id)
  where source = 'live';

create index if not exists trades_live_attribution_idx
  on public.trades (user_id, connection_id, autopilot_workflow_id, strategy_id)
  where book = 'live';

-- Existing live rows can be attributed only from owner-approved execution
-- rows. If more than one wallet is assigned to a connection, the exact wallet
-- stored in user_strategy.params wins; otherwise the active assigned wallet is
-- used. Unprovable rows remain NULL rather than being guessed.
update public.positions p
set
  wallet_connection_id = coalesce(
    case
      when (us.params ->> 'wallet_connection_id') ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then (us.params ->> 'wallet_connection_id')::uuid
      else null
    end,
    (
      select wc.id
      from public.wallet_connections wc
      where wc.user_id = p.user_id
        and wc.assigned_exchange_connection_id = p.connection_id
        and wc.is_active = true
      order by wc.is_default desc, wc.verified_at desc nulls last, wc.created_at desc
      limit 1
    )
  ),
  autopilot_workflow_id = case
    when (us.params ->> 'autopilot_workflow_id') ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then (us.params ->> 'autopilot_workflow_id')::uuid
    else null
  end,
  strategy_id = us.strategy_id
from public.user_strategy us
where p.source = 'live'
  and p.user_id = us.user_id
  and p.connection_id = us.connection_id
  and p.pair = us.symbol
  and us.mode = 'live';

update public.positions p
set decision_id = p.strategy_metadata ->> 'decision_id'
where p.source = 'live'
  and p.decision_id is null
  and exists (
    select 1
    from public.strategy_decisions d
    where d.decision_id = p.strategy_metadata ->> 'decision_id'
  );
