-- SynFutures joins the existing locked mandate admission. No authority, budget,
-- leverage setting, historical intent, or connection is changed by this migration.
CREATE OR REPLACE FUNCTION public.validate_live_mandate_entry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
declare p public.autopilot_workflows%rowtype; cfg jsonb; local_now timestamp; local_time time;
  campaign_exists boolean; admitted integer; occupied integer; realized numeric; chosen_leverage numeric;
begin
  if new.reduce_only then return new; end if;
  -- Native entries cannot bypass mandate admission by omitting their campaign.
  if new.venue = 'synfutures' and new.automation_campaign_key is null then
    raise exception 'LIVE_MANDATE_CAMPAIGN_REQUIRED';
  end if;
  if new.automation_campaign_key is null then return new; end if;
  if new.environment <> 'mainnet' or new.venue not in ('apex_omni','aster','synfutures')
    or length(new.automation_campaign_key) not between 8 and 64 then raise exception 'LIVE_MANDATE_CAMPAIGN_INVALID'; end if;
  select params into cfg from public.user_strategy
    where user_id=new.user_id and connection_id=new.connection_id and mode='live' and enabled
      and replace(symbol,'-','')=replace(new.symbol,'-','');
  if cfg is null or nullif(cfg->>'autopilot_workflow_id','') is null then raise exception 'LIVE_MANDATE_NOT_CONFIGURED'; end if;
  select * into p from public.autopilot_workflows
    where id::text=cfg->>'autopilot_workflow_id' and user_id=new.user_id for update;
  -- Re-read after the mandate lock: an edit may have committed while waiting.
  select params into cfg from public.user_strategy
    where user_id=new.user_id and connection_id=new.connection_id and mode='live' and enabled
      and replace(symbol,'-','')=replace(new.symbol,'-','') and params->>'autopilot_workflow_id'=p.id::text;
  if cfg is null then raise exception 'LIVE_MANDATE_NOT_CONFIGURED'; end if;
  if p.id is null or p.status not in ('live_configured','live_eligible') or not p.schedule_enabled
    or p.proposal->>'setupBook'='paper' then raise exception 'LIVE_MANDATE_NOT_ACTIVE'; end if;
  begin chosen_leverage := (cfg->>'leverage')::numeric;
  exception when invalid_text_representation then raise exception 'LIVE_MANDATE_LEVERAGE_REQUIRED'; end;
  if chosen_leverage is null or chosen_leverage<>trunc(chosen_leverage) or
    chosen_leverage not between 1 and (case when new.venue='aster' then 125 when new.venue='synfutures' then 33 else 100 end)
    then raise exception 'LIVE_MANDATE_LEVERAGE_REQUIRED'; end if;
  if new.venue='synfutures' then
    if new.symbol not in ('BTC-USDC','ETH-USDC') or new.side not in ('BUY','SELL')
      or new.order_type is distinct from 'MARKET' then raise exception 'LIVE_MANDATE_NATIVE_MARKET_INVALID'; end if;
    -- Lock the owned connection after the mandate, then recheck all permissions.
    -- A pending authorization edit cannot race this admission.
    perform 1 from public.exchange_connections c where c.id=new.connection_id
      and c.user_id=new.user_id and c.exchange='synfutures'
      and c.environment in ('mainnet','production') and c.status='verified'
      and c.is_live is true and c.permission_trade is true and c.permissions_verified is true
      for share;
    if not found then raise exception 'LIVE_MANDATE_NATIVE_PERMISSION_REQUIRED'; end if;
  end if;
  new.autopilot_workflow_id := p.id;
  local_now := now() at time zone p.timezone; local_time := local_now::time;
  if not (extract(dow from local_now)::smallint=any(p.active_days)) or
    not (case when p.window_start<=p.window_end then local_time between p.window_start and p.window_end
      else local_time>=p.window_start or local_time<=p.window_end end)
    then raise exception 'LIVE_MANDATE_OUTSIDE_SCHEDULE'; end if;
  if exists(select 1 from public.positions where user_id=new.user_id and autopilot_workflow_id=p.id
    and status::text='closed' and updated_at>=p.approved_at and pnl_amount is null)
    then raise exception 'LIVE_MANDATE_PNL_UNCONFIRMED'; end if;
  select coalesce(sum(pnl_amount),0) into realized from public.positions
    where user_id=new.user_id and autopilot_workflow_id=p.id and status::text='closed' and updated_at>=p.approved_at;
  if realized<=-p.loss_limit then raise exception 'LIVE_MANDATE_LOSS_LIMIT'; end if;
  select exists(select 1 from public.order_intents where autopilot_workflow_id=p.id
    and automation_campaign_key=new.automation_campaign_key) into campaign_exists;
  if campaign_exists then
    if exists(select 1 from public.order_intents where autopilot_workflow_id=p.id
      and automation_campaign_key=new.automation_campaign_key
      and (user_id is distinct from new.user_id or connection_id is distinct from new.connection_id
        or venue is distinct from new.venue or symbol is distinct from new.symbol or side is distinct from new.side))
      or (select count(*) from public.order_intents where autopilot_workflow_id=p.id
        and automation_campaign_key=new.automation_campaign_key and id<>new.id)>=5
      then raise exception 'LIVE_MANDATE_CAMPAIGN_INVALID'; end if;
    return new;
  end if;
  select count(distinct automation_campaign_key) into admitted from public.order_intents
    where autopilot_workflow_id=p.id and not reduce_only and automation_campaign_key is not null
      and (created_at at time zone p.timezone)::date=local_now::date
      and state::text not in ('rejected','failed','cancelled','expired');
  if admitted>=p.max_daily_entries then raise exception 'LIVE_MANDATE_DAILY_ENTRY_LIMIT'; end if;
  -- Count each venue/symbol once. Pending/uncertain campaigns retain capacity
  -- until a newer venue reconciliation confirms that the position is closed.
  select count(*) into occupied from (
    select pos.connection_id,replace(pos.pair,'-','') symbol from public.positions pos
    where pos.user_id=new.user_id and pos.status::text='open' and exists(
      select 1 from public.user_strategy s where s.user_id=pos.user_id and s.connection_id=pos.connection_id
        and s.params->>'autopilot_workflow_id'=p.id::text and replace(s.symbol,'-','')=replace(pos.pair,'-',''))
    union
    select i.connection_id,replace(i.symbol,'-','') from public.order_intents i
    where i.autopilot_workflow_id=p.id and not i.reduce_only and i.automation_campaign_key is not null
      and i.state::text not in ('rejected','failed','cancelled','expired')
      and not exists(select 1 from public.positions pos where pos.user_id=i.user_id
        and pos.connection_id=i.connection_id and replace(pos.pair,'-','')=replace(i.symbol,'-','')
        and pos.status::text='closed' and pos.synced_at>i.created_at)
  ) slots;
  if occupied>=p.max_open_positions then raise exception 'LIVE_MANDATE_POSITION_LIMIT'; end if;
  return new;
end;
$function$;


-- Keep entry ambiguity locked. A separately locked reduction may follow a
-- freshly verified mined entry before finality; the module enforces no increase.
alter table public.synfutures_transactions add column provisional_receipt_block bigint;
alter table public.synfutures_transactions add column provisional_receipt_block_hash text;
alter table public.synfutures_transactions add column provisional_observed_at timestamptz;
alter table public.synfutures_transactions add constraint syn_provisional_receipt_check check(
 (provisional_receipt_block is null and provisional_receipt_block_hash is null and provisional_observed_at is null)
 or (provisional_receipt_block>=0 and provisional_receipt_block_hash ~ '^0x[0-9a-f]{64}$' and provisional_observed_at is not null));
drop index public.synfutures_operator_inflight;
drop index public.synfutures_module_inflight;
create unique index synfutures_operator_inflight on public.synfutures_transactions(chain_id,operator_address,reduce_only)
 where state in ('prepared','broadcast','unknown');
create unique index synfutures_module_inflight on public.synfutures_transactions(chain_id,module_address,reduce_only)
 where state in ('prepared','broadcast','unknown');
create function public.record_synfutures_provisional(p_user_id uuid,p_connection_id uuid,p_intent_id uuid,p_hash text,p_block bigint,p_block_hash text)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
 if (p_block is null) is distinct from (p_block_hash is null) or p_block<0 or p_block_hash !~ '^0x[0-9a-f]{64}$' then
   raise exception 'SYNFUTURES_PROVISIONAL_INVALID'; end if;
 update public.synfutures_transactions set provisional_receipt_block=p_block,provisional_receipt_block_hash=p_block_hash,
   provisional_observed_at=case when p_block is not null then clock_timestamp() else null end
 where intent_id=p_intent_id and user_id=p_user_id and connection_id=p_connection_id and tx_hash=p_hash
   and state in ('prepared','broadcast','unknown');
 return found;
end; $$;
revoke all on function public.record_synfutures_provisional(uuid,uuid,uuid,text,bigint,text) from public,anon,authenticated;
grant execute on function public.record_synfutures_provisional(uuid,uuid,uuid,text,bigint,text) to service_role;
-- Additive native campaign state. Existing code, intents and module are retained.
create table public.synfutures_campaigns (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 connection_id uuid not null, campaign_key text not null check(length(campaign_key) between 8 and 64),
 symbol text not null check(symbol in ('BTC-USDC','ETH-USDC')), side text not null check(side in ('BUY','SELL')),
 autopilot_workflow_id uuid not null references public.autopilot_workflows(id), plan jsonb not null, module_revision numeric not null check(module_revision>=0 and module_revision=trunc(module_revision)),
 status text not null default 'waiting' check(status in ('waiting','active','closing','closed','cancelled','recovery_required')),
 settlement_proof jsonb, reason text, lease_token uuid, lease_until timestamptz, created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(), foreign key(connection_id,user_id) references public.exchange_connections(id,user_id),
 unique(user_id,connection_id,campaign_key)
);
create unique index synfutures_one_campaign_market on public.synfutures_campaigns(connection_id,symbol)
 where status not in ('closed','cancelled');
create table public.synfutures_campaign_actions (
 id uuid primary key default gen_random_uuid(), campaign_id uuid not null references public.synfutures_campaigns(id),
 intent_id uuid not null unique references public.order_intents(id), kind text not null check(kind in ('entry','exit')),
 rung integer not null check(rung between 0 and 5), state text not null check(state in ('planned','signing','failed','completed')),
 lease_token uuid, reason text, created_at timestamptz not null default now(),
 check((kind='entry' and rung>0) or (kind='exit' and rung=0))
);
create unique index syn_entry_rung on public.synfutures_campaign_actions(campaign_id,rung) where kind='entry';
create unique index syn_pending_exit on public.synfutures_campaign_actions(campaign_id) where kind='exit' and state in ('planned','signing');
create table public.synfutures_monitor_snapshots (
 connection_id uuid primary key, user_id uuid not null, snapshot jsonb not null,
 observed_at timestamptz not null default now(), foreign key(connection_id,user_id) references public.exchange_connections(id,user_id)
);
alter table public.synfutures_campaigns enable row level security;
alter table public.synfutures_campaign_actions enable row level security;
alter table public.synfutures_monitor_snapshots enable row level security;
revoke all on public.synfutures_campaigns,public.synfutures_campaign_actions,public.synfutures_monitor_snapshots from public,anon,authenticated;
grant select on public.synfutures_campaigns,public.synfutures_campaign_actions,public.synfutures_monitor_snapshots to authenticated;
grant select,insert,update on public.synfutures_campaigns,public.synfutures_campaign_actions,public.synfutures_monitor_snapshots to service_role;
create policy syn_campaign_owner on public.synfutures_campaigns for select to authenticated using((select auth.uid())=user_id);
create policy syn_monitor_owner on public.synfutures_monitor_snapshots for select to authenticated using((select auth.uid())=user_id);
create policy syn_action_owner on public.synfutures_campaign_actions for select to authenticated using(exists(
 select 1 from public.synfutures_campaigns c where c.id=campaign_id and c.user_id=(select auth.uid())));

create function public.synfutures_campaign_context(p_user_id uuid,p_connection_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
 if not exists(select 1 from public.exchange_connections where id=p_connection_id and user_id=p_user_id
   and exchange='synfutures' and environment in ('mainnet','production')) then raise exception 'SYNFUTURES_CONNECTION_UNCONFIRMED'; end if;
 return jsonb_build_object('resolved_campaign_keys',coalesce((select jsonb_agg(x.campaign_key) from (select campaign_key from public.synfutures_campaigns where user_id=p_user_id and connection_id=p_connection_id and status in ('closed','cancelled') order by updated_at desc limit 20) x),'[]'::jsonb),'monitor_recent',exists(select 1 from public.synfutures_monitor_snapshots where user_id=p_user_id and connection_id=p_connection_id and observed_at>clock_timestamp()-interval '45 seconds'),'strategies',coalesce((select jsonb_agg(jsonb_build_object('symbol',symbol,'params',params,'enabled',enabled,'mode',mode))
   from public.user_strategy where user_id=p_user_id and connection_id=p_connection_id and mode='live'),'[]'::jsonb),
   'campaigns',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('module_revision',c.module_revision::text,
    'actions',coalesce((select jsonb_agg(jsonb_build_object('intent_id',a.intent_id,'kind',a.kind,'rung',a.rung,
      'state',case when t.state in ('prepared','broadcast','unknown') and t.provisional_observed_at>clock_timestamp()-interval '30 seconds' and t.provisional_receipt_block is not null then 'mined' else coalesce(t.state,a.state) end,'signed_size',t.signed_size::text,'margin',t.margin::text,'tx_hash',t.tx_hash,'receipt_block',t.receipt_block::text,'receipt_block_hash',t.receipt_block_hash,'action_id',a.id)
      order by a.created_at,a.rung) from public.synfutures_campaign_actions a left join public.synfutures_transactions t on t.intent_id=a.intent_id
      where a.campaign_id=c.id),'[]'::jsonb))) from public.synfutures_campaigns c where c.user_id=p_user_id
      and c.connection_id=p_connection_id and c.status not in ('closed','cancelled')),'[]'::jsonb));
end; $$;

create function public.create_synfutures_campaign(p_user_id uuid,p_connection_id uuid,p_key text,p_plan jsonb,p_revision text,p_size text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare cfg jsonb; c public.synfutures_campaigns; i uuid; j int; n numeric; previous numeric;
begin
 if p_key is null or length(p_key) not between 8 and 64 or jsonb_typeof(p_plan)<>'object'
   or not (p_plan ?& array['version','symbol','side','leverage','margin_total','margin_per_rung','reference_mark','triggers','stop_price','take_profit_bps','starting_balance','start_block'])
   or p_plan->>'version'<>'1' or p_plan->>'symbol' not in ('BTC-USDC','ETH-USDC') or p_plan->>'side' not in ('BUY','SELL')
   or (p_plan-array['version','symbol','side','leverage','margin_total','margin_per_rung','reference_mark','triggers','stop_price','take_profit_bps','starting_balance','start_block'])<>'{}'::jsonb
   or p_revision !~ '^(0|[1-9][0-9]{0,77})$' or p_size !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$' or p_size::numeric<=0
   or jsonb_array_length(p_plan->'triggers')<>5 then raise exception 'SYNFUTURES_CAMPAIGN_INVALID'; end if;
 select params into cfg from public.user_strategy where user_id=p_user_id and connection_id=p_connection_id and symbol=p_plan->>'symbol' and mode='live' and enabled;
 if cfg is null or cfg->>'native_locally_monitored_exits_accepted' is distinct from 'true' or (cfg->>'leverage')::numeric is distinct from (p_plan->>'leverage')::numeric
   or (cfg->>'margin_usdc')::numeric*1e18 is distinct from (p_plan->>'margin_total')::numeric
   or (cfg->>'native_take_profit_bps')::integer is distinct from (p_plan->>'take_profit_bps')::integer
   or (p_plan->>'leverage')::integer not between 1 and 33
   or (p_plan->>'take_profit_bps')::integer not between 1 and 9999
   or (p_plan->>'margin_per_rung')::numeric<=0
   or (p_plan->>'margin_total')::numeric<>(p_plan->>'margin_per_rung')::numeric*5
   then raise exception 'SYNFUTURES_CAMPAIGN_CONFIGURATION_REQUIRED'; end if;
 for j in 0..4 loop
   n := (p_plan->'triggers'->>j)::numeric;
   if n<=0 or n<>trunc(n) or (previous is not null and (case p_plan->>'side' when 'BUY' then n>=previous else n<=previous end))
     then raise exception 'SYNFUTURES_CAMPAIGN_PRICE_INVALID'; end if;
   previous := n;
 end loop;
 n := (p_plan->>'stop_price')::numeric;
 if n<=0 or n<>trunc(n) or (case p_plan->>'side' when 'BUY' then n>=previous else n<=previous end)
   then raise exception 'SYNFUTURES_CAMPAIGN_PRICE_INVALID'; end if;
 -- Serialize creation with the SAME mandate lock used by the admission trigger.
 perform 1 from public.autopilot_workflows where id::text=cfg->>'autopilot_workflow_id' and user_id=p_user_id for update;
 if not found then raise exception 'LIVE_MANDATE_NOT_CONFIGURED'; end if;
 select * into c from public.synfutures_campaigns where user_id=p_user_id and connection_id=p_connection_id and campaign_key=p_key;
 if found then
   if c.symbol<>p_plan->>'symbol' or c.side<>p_plan->>'side' or c.plan->>'margin_total'<>p_plan->>'margin_total'
     or c.plan->>'leverage'<>p_plan->>'leverage' or c.plan->>'take_profit_bps'<>p_plan->>'take_profit_bps' then raise exception 'SYNFUTURES_CAMPAIGN_REPLAY_MISMATCH'; end if;
   return jsonb_build_object('id',c.id,'created',false,'status',c.status);
 end if;
 -- This first intent owns the daily/open-position reservation. It is planned,
 -- not a signed or broadcast order; price must first reach the pullback trigger.
 insert into public.order_intents(user_id,connection_id,client_order_id,environment,venue,symbol,side,order_type,size,reduce_only,state,automation_campaign_key)
 values(p_user_id,p_connection_id,p_key||'-r1','mainnet','synfutures',p_plan->>'symbol',p_plan->>'side','MARKET',p_size::numeric,false,'signing',p_key) returning id into i;
 insert into public.synfutures_campaigns(user_id,connection_id,campaign_key,symbol,side,autopilot_workflow_id,plan,module_revision)
 values(p_user_id,p_connection_id,p_key,p_plan->>'symbol',p_plan->>'side',(select autopilot_workflow_id from public.order_intents where id=i),p_plan,p_revision::numeric) returning * into c;
 insert into public.synfutures_campaign_actions(campaign_id,intent_id,kind,rung,state) values(c.id,i,'entry',1,'planned');
 return jsonb_build_object('id',c.id,'created',true,'status',c.status);
end; $$;

create function public.claim_synfutures_campaign(p_user_id uuid,p_connection_id uuid,p_campaign_id uuid,p_token uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
declare c public.synfutures_campaigns;
begin
 select * into c from public.synfutures_campaigns where id=p_campaign_id and user_id=p_user_id and connection_id=p_connection_id for update;
 if not found or c.status in ('closed','cancelled') or p_token is null
   or (c.lease_until>clock_timestamp() and c.lease_token is distinct from p_token) then return false; end if;
 update public.synfutures_campaign_actions set state='failed',reason='SYNFUTURES_PREPARATION_ABANDONED'
 where campaign_id=c.id and state='signing' and lease_token is distinct from p_token
 and not exists(select 1 from public.synfutures_transactions t where t.intent_id=synfutures_campaign_actions.intent_id);
 update public.order_intents set state='failed',state_reason='SYNFUTURES_PREPARATION_ABANDONED' where id in
 (select intent_id from public.synfutures_campaign_actions where campaign_id=c.id and state='failed') and state='signing';
 update public.synfutures_campaigns set lease_token=p_token,lease_until=clock_timestamp()+interval '90 seconds' where id=c.id;
 return true;
end; $$;

create function public.synfutures_campaign_config_matches(p_campaign_id uuid)
returns boolean language sql security invoker set search_path='' as $$
 select exists(select 1 from public.synfutures_campaigns c join public.user_strategy s on s.user_id=c.user_id and s.connection_id=c.connection_id and s.symbol=c.symbol
  where c.id=p_campaign_id and s.params->>'autopilot_workflow_id'=c.autopilot_workflow_id::text and s.enabled and s.mode='live' and s.params->>'native_locally_monitored_exits_accepted'='true'
  and (s.params->>'leverage')::numeric=(c.plan->>'leverage')::numeric
  and (s.params->>'margin_usdc')::numeric*1e18=(c.plan->>'margin_total')::numeric
  and (s.params->>'native_take_profit_bps')::numeric=(c.plan->>'take_profit_bps')::numeric);
$$;
revoke all on function public.synfutures_campaign_config_matches(uuid) from public,anon,authenticated;
grant execute on function public.synfutures_campaign_config_matches(uuid) to service_role;

create function public.prepare_synfutures_action(p_user_id uuid,p_connection_id uuid,p_campaign_id uuid,p_token uuid,p_kind text,p_rung int,p_size text,p_reason text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare c public.synfutures_campaigns; a public.synfutures_campaign_actions; i uuid; filled int;
begin
 select * into c from public.synfutures_campaigns where id=p_campaign_id and user_id=p_user_id and connection_id=p_connection_id for update;
 if not found or p_token is null or c.lease_token is null or c.lease_until is null or c.lease_token is distinct from p_token or c.lease_until<=clock_timestamp() or c.status in ('closed','cancelled')
   then raise exception 'SYNFUTURES_CAMPAIGN_LEASE_REQUIRED'; end if;
 if p_size is null or p_size !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$' or p_size::numeric<=0
   or p_kind not in ('entry','exit') or (p_kind='entry' and p_rung not between 1 and 5) or (p_kind='exit' and p_rung<>0)
   then raise exception 'SYNFUTURES_ACTION_INVALID'; end if;
 if exists(select 1 from public.synfutures_campaign_actions x left join public.synfutures_transactions t on t.intent_id=x.intent_id
   where x.campaign_id=c.id and ((t.state in ('prepared','broadcast','unknown') and (p_kind='entry' or x.kind='exit' or t.provisional_receipt_block is null or t.provisional_observed_at<=clock_timestamp()-interval '30 seconds')) or (x.state='signing' and t.intent_id is null)))
   then raise exception 'SYNFUTURES_TRANSACTION_IN_FLIGHT'; end if;
 select count(*) into filled from public.synfutures_campaign_actions x join public.synfutures_transactions t on t.intent_id=x.intent_id
   where x.campaign_id=c.id and x.kind='entry' and t.state='confirmed';
 if p_kind='entry' and not public.synfutures_campaign_config_matches(c.id) then raise exception 'SYNFUTURES_CAMPAIGN_CONFIGURATION_MISMATCH'; end if;
 if p_kind='entry' and (c.status not in ('waiting','active') or p_rung<>filled+1)
   then raise exception 'SYNFUTURES_RUNG_HISTORY_INVALID'; end if;
 select * into a from public.synfutures_campaign_actions where campaign_id=c.id and kind=p_kind and rung=p_rung and (kind='entry' or state in ('planned','signing')); 
 if found then
   if a.state<>'planned' then raise exception 'SYNFUTURES_ACTION_ALREADY_PREPARED'; end if;
   i := a.intent_id;
   -- Re-run admission at actual dispatch, including pause, schedule and loss.
   update public.order_intents set size=p_size::numeric where id=i and state='signing';
   if not found then raise exception 'SYNFUTURES_INTENT_MISMATCH'; end if;
 else
   insert into public.order_intents(user_id,connection_id,client_order_id,environment,venue,symbol,side,order_type,size,reduce_only,state,automation_campaign_key)
   values(c.user_id,c.connection_id,c.campaign_key||case p_kind when 'entry' then '-r'||p_rung else '-x-'||substr(gen_random_uuid()::text,1,8) end,
     'mainnet','synfutures',c.symbol,case when p_kind='entry' then c.side when c.side='BUY' then 'SELL' else 'BUY' end,
     'MARKET',p_size::numeric,p_kind='exit','signing',case when p_kind='entry' then c.campaign_key else null end) returning id into i;
   insert into public.synfutures_campaign_actions(campaign_id,intent_id,kind,rung,state) values(c.id,i,p_kind,p_rung,'planned') returning * into a;
 end if;
 update public.synfutures_campaign_actions set state='signing',lease_token=p_token,reason=p_reason where intent_id=i;
 update public.synfutures_campaigns set status=case p_kind when 'exit' then 'closing' else 'active' end,updated_at=clock_timestamp() where id=c.id;
 return jsonb_build_object('intent_id',i);
end; $$;

create function public.finish_synfutures_campaign(p_user_id uuid,p_connection_id uuid,p_campaign_id uuid,p_token uuid,p_status text,p_reason text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare c public.synfutures_campaigns;
begin
 select * into c from public.synfutures_campaigns where id=p_campaign_id and user_id=p_user_id and connection_id=p_connection_id for update;
 if not found or p_token is null or c.lease_token is null or c.lease_until is null or c.lease_token is distinct from p_token or c.lease_until<=clock_timestamp()
   or p_status not in ('waiting','active','closing','closed','cancelled','recovery_required') then return false; end if;
 if p_status='closed' and c.settlement_proof is null then raise exception 'SYNFUTURES_REALIZED_PNL_UNCONFIRMED'; end if;
 if p_status in ('closed','cancelled') and exists(select 1 from public.synfutures_campaign_actions a
   left join public.synfutures_transactions t on t.intent_id=a.intent_id where a.campaign_id=c.id
   and (t.state in ('prepared','broadcast','unknown') or (a.state='signing' and t.intent_id is null)))
   then raise exception 'SYNFUTURES_TRANSACTION_IN_FLIGHT'; end if;
 update public.synfutures_campaigns set status=p_status,reason=p_reason,lease_token=null,lease_until=null,updated_at=clock_timestamp() where id=c.id;
 if p_status='cancelled' then update public.order_intents set state='cancelled',state_reason=p_reason where id in
   (select intent_id from public.synfutures_campaign_actions where campaign_id=c.id and state='planned'); end if;
 return true;
end; $$;

create function public.verify_synfutures_campaign_reservation() returns trigger language plpgsql security invoker set search_path='' as $$
declare a public.synfutures_campaign_actions; c public.synfutures_campaigns;
begin
 select * into a from public.synfutures_campaign_actions where intent_id=new.intent_id;
 if not found then
   if not new.reduce_only then raise exception 'SYNFUTURES_PROTECTIVE_CAMPAIGN_REQUIRED'; end if;
   return new;
 end if;
 select * into c from public.synfutures_campaigns where id=a.campaign_id for update;
 if not new.reduce_only and not public.synfutures_campaign_config_matches(c.id) then raise exception 'SYNFUTURES_CAMPAIGN_CONFIGURATION_MISMATCH'; end if;
 if not new.reduce_only and exists(select 1 from public.synfutures_transactions t where t.connection_id=new.connection_id
   and t.state in ('prepared','broadcast','unknown')) then raise exception 'SYNFUTURES_TRANSACTION_IN_FLIGHT'; end if;
 if new.reduce_only and exists(select 1 from public.synfutures_transactions t where t.connection_id=new.connection_id
   and t.state in ('prepared','broadcast','unknown') and (t.reduce_only or t.provisional_receipt_block is null
     or t.provisional_observed_at<=clock_timestamp()-interval '30 seconds')) then raise exception 'SYNFUTURES_TRANSACTION_IN_FLIGHT'; end if;
 if c.lease_token is null or a.lease_token is null or c.lease_until is null or c.user_id<>new.user_id or c.connection_id<>new.connection_id or c.lease_token is distinct from a.lease_token
   or c.lease_until<=clock_timestamp() or a.state<>'signing' or new.module_revision<>c.module_revision
   or (a.kind='entry' and (new.reduce_only or c.status<>'active' or new.margin<>(c.plan->>'margin_per_rung')::numeric))
   or (a.kind='exit' and (not new.reduce_only or new.margin<>0 or c.status<>'closing'))
   then raise exception 'SYNFUTURES_CAMPAIGN_RESERVATION_INVALID'; end if;
 return new;
end; $$;
create trigger verify_synfutures_campaign_reservation before insert on public.synfutures_transactions
 for each row execute function public.verify_synfutures_campaign_reservation();
-- Root rung's size is refreshed only when its pullback actually triggers.
create trigger synfutures_dispatch_admission before update of size on public.order_intents
 for each row when(new.venue='synfutures' and not new.reduce_only) execute function public.validate_live_mandate_entry();

revoke all on function public.synfutures_campaign_context(uuid,uuid),public.create_synfutures_campaign(uuid,uuid,text,jsonb,text,text),
 public.claim_synfutures_campaign(uuid,uuid,uuid,uuid),public.prepare_synfutures_action(uuid,uuid,uuid,uuid,text,int,text,text),
 public.finish_synfutures_campaign(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.synfutures_campaign_context(uuid,uuid),public.create_synfutures_campaign(uuid,uuid,text,jsonb,text,text),
 public.claim_synfutures_campaign(uuid,uuid,uuid,uuid),public.prepare_synfutures_action(uuid,uuid,uuid,uuid,text,int,text,text),
 public.finish_synfutures_campaign(uuid,uuid,uuid,uuid,text,text) to service_role;

create function public.fail_synfutures_action(p_user_id uuid,p_connection_id uuid,p_campaign_id uuid,p_token uuid,p_intent_id uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
declare c public.synfutures_campaigns;
begin
 select * into c from public.synfutures_campaigns where id=p_campaign_id and user_id=p_user_id and connection_id=p_connection_id for update;
 if not found or c.lease_token is distinct from p_token or c.lease_until<=clock_timestamp() then return false; end if;
 perform 1 from public.order_intents where id=p_intent_id for update;
 if exists(select 1 from public.synfutures_transactions where intent_id=p_intent_id) then return false; end if;
 update public.synfutures_campaign_actions set state='failed',reason='SYNFUTURES_PREFLIGHT_FAILED'
 where campaign_id=c.id and intent_id=p_intent_id and lease_token=p_token and state='signing';
 if not found then return false; end if;
 update public.order_intents set state='failed',state_reason='SYNFUTURES_PREFLIGHT_FAILED' where id=p_intent_id and state='signing';
 return true;
end; $$;
revoke all on function public.fail_synfutures_action(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fail_synfutures_action(uuid,uuid,uuid,uuid,uuid) to service_role;
create or replace function public.reserve_synfutures_transaction(p_user_id uuid,p_connection_id uuid,p_intent_id uuid,p_tx jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare i public.order_intents; existing public.synfutures_transactions; t public.synfutures_transactions;
begin
  if jsonb_typeof(p_tx)<>'object' or p_tx is null or (p_tx - array[
    'operator_address','module_address','safe_address','instrument_address','operator_nonce',
    'module_revision','module_nonce','signed_size','margin','reduce_only','tx_hash'])<>'{}'::jsonb then
    raise exception 'SYNFUTURES_TRANSACTION_INVALID';
  end if;
  -- Campaign -> intent -> journal lock order matches dispatch/failure recovery.
  perform 1 from public.synfutures_campaigns c join public.synfutures_campaign_actions a on a.campaign_id=c.id
    where a.intent_id=p_intent_id and c.user_id=p_user_id and c.connection_id=p_connection_id for update of c;
  select * into i from public.order_intents where id=p_intent_id and user_id=p_user_id
    and connection_id=p_connection_id and venue='synfutures' and environment='mainnet' for update;
  if not found or not exists(select 1 from public.exchange_connections where id=p_connection_id
    and user_id=p_user_id and exchange='synfutures' and environment in ('mainnet','production')) then
    raise exception 'SYNFUTURES_INTENT_NOT_FOUND';
  end if;
  select * into existing from public.synfutures_transactions where intent_id=i.id;
  if found then
    if (to_jsonb(existing) - array['intent_id','user_id','connection_id','chain_id','state','receipt_block',
      'receipt_block_hash','created_at','updated_at','provisional_receipt_block','provisional_receipt_block_hash','provisional_observed_at']) <> jsonb_build_object(
      'operator_address',p_tx->>'operator_address','module_address',p_tx->>'module_address',
      'safe_address',p_tx->>'safe_address','instrument_address',p_tx->>'instrument_address',
      'operator_nonce',(p_tx->>'operator_nonce')::numeric,'module_revision',(p_tx->>'module_revision')::numeric,
      'module_nonce',(p_tx->>'module_nonce')::numeric,'signed_size',(p_tx->>'signed_size')::numeric,
      'margin',(p_tx->>'margin')::numeric,'reduce_only',(p_tx->>'reduce_only')::boolean,'tx_hash',p_tx->>'tx_hash') then
      raise exception 'SYNFUTURES_INTENT_REPLAY_MISMATCH';
    end if;
    return jsonb_build_object('created',false,'tx_hash',existing.tx_hash);
  end if;
  if i.state<>'signing' or i.order_type<>'MARKET' or i.symbol not in ('BTC-USDC','ETH-USDC')
    or (p_tx->>'reduce_only')::boolean is distinct from i.reduce_only
    or (p_tx->>'signed_size')::numeric is distinct from i.size*1000000000000000000*(case when i.side='BUY' then 1 else -1 end)
    or p_tx->>'instrument_address' is distinct from (case i.symbol when 'BTC-USDC' then
      '0xec6c44e704eb1932ec5fe1e4aba58db6fee71460' else '0x04d72fb4803b4e02f14971e5bd092375eb330749' end) then
    raise exception 'SYNFUTURES_INTENT_MISMATCH';
  end if;
  -- Admission is checked again under the dispatch transaction locks, so a
  -- newly paused/revoked mandate cannot race a signed reservation.
  if not i.reduce_only then update public.order_intents set size=size where id=i.id; end if;
  insert into public.synfutures_transactions(intent_id,user_id,connection_id,operator_address,module_address,
    safe_address,instrument_address,operator_nonce,module_revision,module_nonce,signed_size,margin,reduce_only,tx_hash)
  values(i.id,i.user_id,i.connection_id,p_tx->>'operator_address',p_tx->>'module_address',p_tx->>'safe_address',
    p_tx->>'instrument_address',(p_tx->>'operator_nonce')::numeric,(p_tx->>'module_revision')::numeric,
    (p_tx->>'module_nonce')::numeric,(p_tx->>'signed_size')::numeric,(p_tx->>'margin')::numeric,
    (p_tx->>'reduce_only')::boolean,p_tx->>'tx_hash') returning * into t;
  update public.order_intents set state='reconciliation_required',exchange_order_id=t.tx_hash,
    state_reason='SYNFUTURES_TRANSACTION_PREPARED' where id=i.id;
  return jsonb_build_object('created',true,'tx_hash',t.tx_hash);
end;
$$;

create or replace function public.observe_synfutures_transaction(p_user_id uuid,p_connection_id uuid,p_intent_id uuid,
  p_tx_hash text,p_state text,p_block bigint default null,p_block_hash text default null)
returns uuid language plpgsql security invoker set search_path='' as $$
declare t public.synfutures_transactions;
begin
  -- Same lock order as reservation: intent first, then child transaction.
  perform 1 from public.order_intents where id=p_intent_id and user_id=p_user_id and connection_id=p_connection_id for update;
  select * into t from public.synfutures_transactions where intent_id=p_intent_id and user_id=p_user_id
    and connection_id=p_connection_id and tx_hash=p_tx_hash for update;
  if not found then raise exception 'SYNFUTURES_TRANSACTION_NOT_FOUND'; end if;
  if p_state is null or p_state not in ('broadcast','unknown','confirmed','reverted')
    or (p_state in ('confirmed','reverted') and (p_block is null or p_block_hash is null))
    or (p_state in ('broadcast','unknown') and (p_block is not null or p_block_hash is not null)) then
    raise exception 'SYNFUTURES_OBSERVATION_INVALID';
  end if;
  if t.state in ('confirmed','reverted') then
    if t.state<>p_state or t.receipt_block is distinct from p_block or t.receipt_block_hash is distinct from p_block_hash then
      raise exception 'SYNFUTURES_FINALITY_CONFLICT';
    end if;
    return t.intent_id;
  end if;
  update public.synfutures_transactions set state=p_state,receipt_block=p_block,receipt_block_hash=p_block_hash,
    updated_at=clock_timestamp() where intent_id=t.intent_id;
  update public.order_intents set state=case p_state when 'confirmed' then 'filled'::public.order_intent_state
    when 'reverted' then 'failed'::public.order_intent_state when 'broadcast' then 'submitted'::public.order_intent_state
    else 'reconciliation_required'::public.order_intent_state end,
    filled_size=case when p_state='confirmed' then size else filled_size end,
    exchange_status='SYNFUTURES_'||upper(p_state),state_reason=case when p_state='unknown' then 'SYNFUTURES_RECEIPT_UNCONFIRMED'
      when p_state='reverted' then 'SYNFUTURES_TRANSACTION_REVERTED' else null end,
    last_reconciled_at=clock_timestamp() where id=t.intent_id;
  update public.synfutures_campaign_actions set state=case when p_state='confirmed' then 'completed' else 'failed' end
    where intent_id=t.intent_id and p_state in ('confirmed','reverted');
  return t.intent_id;
end;
$$;

create function public.settle_synfutures_campaign(p_user_id uuid,p_connection_id uuid,p_campaign_id uuid,p_token uuid,p_proof jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare c public.synfutures_campaigns; wf uuid;
begin
 select * into c from public.synfutures_campaigns where id=p_campaign_id and user_id=p_user_id and connection_id=p_connection_id for update;
 if not found or c.lease_token is distinct from p_token or c.lease_until<=clock_timestamp() or c.status in ('closed','cancelled')
   then raise exception 'SYNFUTURES_CAMPAIGN_LEASE_REQUIRED'; end if;
 if p_proof is null or jsonb_typeof(p_proof)<>'object' or not (p_proof ?& array['realized_pnl','receipt_block','receipt_block_hash','closing_tx_hash','entry_price','maximum_size','mark']) or (p_proof-array['realized_pnl','receipt_block','receipt_block_hash','closing_tx_hash','entry_price','maximum_size','mark'])<>'{}'::jsonb
  or p_proof->>'realized_pnl' !~ '^-?(0|[1-9][0-9]{0,77})$' or p_proof->>'receipt_block' !~ '^[0-9]{1,16}$'
  or p_proof->>'receipt_block_hash' !~ '^0x[0-9a-f]{64}$' or p_proof->>'closing_tx_hash' !~ '^0x[0-9a-f]{64}$'
  or (p_proof->>'entry_price')::numeric<=0 or (p_proof->>'maximum_size')::numeric<=0 or (p_proof->>'mark')::numeric<=0
  then raise exception 'SYNFUTURES_REALIZED_PNL_UNCONFIRMED'; end if;
 if not exists(select 1 from public.synfutures_campaign_actions a join public.synfutures_transactions t on t.intent_id=a.intent_id where a.campaign_id=c.id and a.kind='entry' and t.state='confirmed')
  or (p_proof->>'receipt_block')::numeric<=(c.plan->>'start_block')::numeric then raise exception 'SYNFUTURES_REALIZED_PNL_UNCONFIRMED'; end if;
 if exists(select 1 from public.synfutures_campaign_actions a left join public.synfutures_transactions t on t.intent_id=a.intent_id
   where a.campaign_id=c.id and (t.state in ('prepared','broadcast','unknown') or (a.state='signing' and t.intent_id is null)))
  then raise exception 'SYNFUTURES_TRANSACTION_IN_FLIGHT'; end if;
 select i.autopilot_workflow_id into wf from public.order_intents i join public.synfutures_campaign_actions a on a.intent_id=i.id where a.campaign_id=c.id and a.kind='entry' and a.rung=1;
 insert into public.positions(id,user_id,exchange,market_type,pair,side,entry_price,current_price,size,leverage,pnl_amount,pnl_pct,status,opened_at,updated_at,connection_id,strategy_metadata,source,venue_order_id,unrealized_pnl,mark_price,synced_at,autopilot_workflow_id)
 values(c.id,c.user_id,'synfutures','futures',c.symbol,case c.side when 'BUY' then 'long'::public.position_side else 'short'::public.position_side end,
  (p_proof->>'entry_price')::numeric/1e18,(p_proof->>'mark')::numeric/1e18,(p_proof->>'maximum_size')::numeric/1e18,
  (c.plan->>'leverage')::numeric,(p_proof->>'realized_pnl')::numeric/1e18,(p_proof->>'realized_pnl')::numeric/(c.plan->>'margin_total')::numeric*100,'closed',c.created_at,clock_timestamp(),c.connection_id,
  jsonb_build_object('native_campaign_id',c.id,'realized_pnl_verified',true,'settlement',p_proof),'live',p_proof->>'closing_tx_hash',0,(p_proof->>'mark')::numeric/1e18,clock_timestamp(),wf)
 on conflict(id) do update set status='closed',pnl_amount=excluded.pnl_amount,pnl_pct=excluded.pnl_pct,current_price=excluded.current_price,
 strategy_metadata=excluded.strategy_metadata,unrealized_pnl=0,updated_at=excluded.updated_at,synced_at=excluded.synced_at,venue_order_id=excluded.venue_order_id
 where positions.user_id=c.user_id and positions.connection_id=c.connection_id and positions.exchange='synfutures';
 if not found then raise exception 'SYNFUTURES_POSITION_BINDING_MISMATCH'; end if;
 update public.synfutures_campaigns set settlement_proof=p_proof where id=c.id;
 return true;
end; $$;
revoke all on function public.settle_synfutures_campaign(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.settle_synfutures_campaign(uuid,uuid,uuid,uuid,jsonb) to service_role;
-- A missing or unverified native realized PNL record is never implicit zero.
create function public.synfutures_unknown_pnl_guard() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if not new.reduce_only and exists(select 1 from public.positions p where p.user_id=new.user_id and p.exchange='synfutures'
   and p.status='closed' and p.strategy_metadata->>'realized_pnl_verified' is distinct from 'true')
 then raise exception 'LIVE_MANDATE_PNL_UNCONFIRMED'; end if;
 return new;
end; $$;
create trigger aa_synfutures_unknown_pnl_guard before insert or update of size on public.order_intents for each row execute function public.synfutures_unknown_pnl_guard();
create function public.write_synfutures_monitor(p_user_id uuid,p_connection_id uuid,p_snapshot jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare c public.synfutures_campaigns; p jsonb; signed_size numeric; entry numeric; mark numeric; estimate numeric; wf uuid;
begin
 if not exists(select 1 from public.exchange_connections where id=p_connection_id and user_id=p_user_id and exchange='synfutures')
 then raise exception 'SYNFUTURES_CONNECTION_UNCONFIRMED'; end if;
 insert into public.synfutures_monitor_snapshots(connection_id,user_id,snapshot) values(p_connection_id,p_user_id,p_snapshot)
 on conflict(connection_id) do update set snapshot=excluded.snapshot,observed_at=clock_timestamp() where synfutures_monitor_snapshots.user_id=p_user_id;
 for c in select * from public.synfutures_campaigns where user_id=p_user_id and connection_id=p_connection_id and status not in ('closed','cancelled') loop
  p:=p_snapshot->'positions'->c.symbol;signed_size:=(p->>'signed_size')::numeric;
  if signed_size<>0 then
   entry:=(p->>'entry_notional')::numeric/abs(signed_size);mark:=(p->>'mark')::numeric/1e18;
   estimate:=case when signed_size>0 then abs(signed_size)/1e18*mark-(p->>'entry_notional')::numeric/1e18 else (p->>'entry_notional')::numeric/1e18-abs(signed_size)/1e18*mark end;
   select i.autopilot_workflow_id into wf from public.order_intents i join public.synfutures_campaign_actions a on a.intent_id=i.id where a.campaign_id=c.id and a.kind='entry' and a.rung=1;
   insert into public.positions(id,user_id,exchange,market_type,pair,side,entry_price,current_price,size,leverage,pnl_amount,pnl_pct,status,opened_at,updated_at,connection_id,strategy_metadata,source,unrealized_pnl,mark_price,synced_at,autopilot_workflow_id)
   values(c.id,c.user_id,'synfutures','futures',c.symbol,case when signed_size>0 then 'long'::public.position_side else 'short'::public.position_side end,
    entry,mark,abs(signed_size)/1e18,(c.plan->>'leverage')::numeric,0,0,'open',c.created_at,clock_timestamp(),c.connection_id,
    jsonb_build_object('native_campaign_id',c.id,'realized_pnl_verified',false,'unrealized_pnl_is_estimate',true),'live',estimate,mark,clock_timestamp(),wf)
   on conflict(id) do update set entry_price=excluded.entry_price,current_price=excluded.current_price,size=excluded.size,
    unrealized_pnl=excluded.unrealized_pnl,mark_price=excluded.mark_price,updated_at=excluded.updated_at,synced_at=excluded.synced_at
   where positions.user_id=c.user_id and positions.connection_id=c.connection_id and positions.exchange='synfutures' and positions.status='open';
  end if;
 end loop;
 return true;
end; $$;
revoke all on function public.write_synfutures_monitor(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.write_synfutures_monitor(uuid,uuid,jsonb) to service_role;
