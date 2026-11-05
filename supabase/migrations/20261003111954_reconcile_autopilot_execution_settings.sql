alter table public.autopilot_workflows drop constraint if exists autopilot_workflows_daily_entries_check;
alter table public.autopilot_workflows add constraint autopilot_workflows_daily_entries_check check(max_daily_entries between 1 and 100);
-- Explicit owner edits only. Never infer leverage, arm a row, resume a venue,
-- move funds, change strategy selection, or modify existing positions.
create or replace function public.update_autopilot_execution_settings(
  _actor_id uuid, _workflow_id uuid, _expected_updated_at timestamptz,
  _leverage integer, _max_daily_entries integer, _max_open_positions integer
) returns void language plpgsql security invoker set search_path = '' as $$
declare p public.autopilot_workflows%rowtype; ceiling integer; changed integer;
begin
  if _actor_id is null or _expected_updated_at is null then raise exception 'Owner and plan revision required'; end if;
  if _leverage is null or _leverage not between 1 and 125 or
     _max_daily_entries is null or _max_daily_entries not between 1 and 100 or
     _max_open_positions is null or _max_open_positions not between 1 and 6
    then raise exception 'Choose valid leverage and entry limits'; end if;
  select * into p from public.autopilot_workflows
    where id=_workflow_id and user_id=_actor_id for update;
  if not found or p.status in ('archived','rejected') then raise exception 'Active plan not found'; end if;
  if p.updated_at is distinct from _expected_updated_at then raise exception 'Plan changed in another session. Reload before saving'; end if;
  if not exists(select 1 from public.user_strategy where user_id=_actor_id and mode='live'
      and params->>'autopilot_workflow_id'=_workflow_id::text)
    then raise exception 'This plan has no live execution rows'; end if;
  if exists(select 1 from public.user_strategy s left join public.exchange_connections c
      on c.id=s.connection_id and c.user_id=s.user_id
      where s.user_id=_actor_id and s.params->>'autopilot_workflow_id'=_workflow_id::text
      and (c.id is null or c.exchange not in ('apex_omni','aster') or c.environment not in ('mainnet','production','live')
        or c.status::text <> 'verified' or not coalesce(c.permissions_verified and c.permission_read and c.permission_trade,false)))
    then raise exception 'A plan route is not a verified supported live venue'; end if;
  select case when bool_or(c.exchange='apex_omni') then 100 else 125 end into ceiling
    from public.user_strategy s join public.exchange_connections c on c.id=s.connection_id and c.user_id=s.user_id
    where s.user_id=_actor_id and s.params->>'autopilot_workflow_id'=_workflow_id::text;
  if ceiling is null or _leverage>ceiling then raise exception 'Leverage exceeds a selected venue ceiling'; end if;
  update public.user_strategy set params=coalesce(params,'{}'::jsonb) || jsonb_build_object(
    'leverage',_leverage,'max_daily_entries',_max_daily_entries,'max_open_positions',_max_open_positions),updated_at=now()
    where user_id=_actor_id and params->>'autopilot_workflow_id'=_workflow_id::text;
  get diagnostics changed = row_count;
  update public.autopilot_workflows set max_daily_entries=_max_daily_entries,max_open_positions=_max_open_positions,
    proposal=coalesce(proposal,'{}'::jsonb) || jsonb_build_object('leverage',_leverage,
      'maxDailyEntries',_max_daily_entries,'maxOpenPositions',_max_open_positions),updated_at=now()
    where id=_workflow_id and user_id=_actor_id;
  insert into public.bot_events(user_id,level,event,detail) values(_actor_id,'info','AUTOPILOT_EXECUTION_SETTINGS_UPDATED',
    jsonb_build_object('workflow_id',_workflow_id,'leverage',_leverage,'max_daily_entries',_max_daily_entries,
      'max_open_positions',_max_open_positions,'rows_updated',changed,'execution_authority_changed',false));
end;
$$;
-- The authenticated Edge Function supplies the verified owner; browser callers
-- cannot impersonate _actor_id or call this privileged mutation directly.
revoke all on function public.update_autopilot_execution_settings(uuid,uuid,timestamptz,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.update_autopilot_execution_settings(uuid,uuid,timestamptz,integer,integer,integer) to service_role;

-- A single database lock serializes campaign admission across worker replicas,
-- symbols and venue requests belonging to the same mandate. Five rungs consume
-- one campaign slot, not five entries. Existing/history/manual rows stay intact.
alter table public.order_intents add column if not exists automation_campaign_key text;
alter table public.order_intents add column if not exists autopilot_workflow_id uuid references public.autopilot_workflows(id);
create index if not exists order_intents_autopilot_campaign_idx
  on public.order_intents(autopilot_workflow_id,automation_campaign_key,created_at)
  where automation_campaign_key is not null;
create or replace function public.validate_live_mandate_entry()
returns trigger language plpgsql security invoker set search_path='' as $$
declare p public.autopilot_workflows%rowtype; cfg jsonb; local_now timestamp; local_time time;
  campaign_exists boolean; admitted integer; occupied integer; realized numeric; chosen_leverage numeric;
begin
  if new.reduce_only or new.automation_campaign_key is null then return new; end if;
  if new.environment <> 'mainnet' or new.venue not in ('apex_omni','aster')
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
    chosen_leverage not between 1 and (case when new.venue='aster' then 125 else 100 end)
    then raise exception 'LIVE_MANDATE_LEVERAGE_REQUIRED'; end if;
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
      and (connection_id<>new.connection_id or symbol<>new.symbol or side<>new.side))
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
$$;
drop trigger if exists validate_live_mandate_entry on public.order_intents;
create trigger validate_live_mandate_entry before insert on public.order_intents
  for each row execute function public.validate_live_mandate_entry();
