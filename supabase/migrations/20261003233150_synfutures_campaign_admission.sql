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
        and automation_campaign_key=new.automation_campaign_key)>=5
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
$function$

