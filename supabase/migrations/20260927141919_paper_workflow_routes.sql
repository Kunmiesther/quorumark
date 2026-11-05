-- Additive paper isolation: no existing workflow, live row, order or wallet is rewritten.
-- Approved paper routes live in the workflow; user_strategy remains the legacy/live route store.
create or replace function public.guard_paper_workflow_routes() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare a jsonb;
begin
  if new.proposal->>'paperRouteVersion' is distinct from '1' then return new; end if;
  if new.proposal->>'setupBook' is distinct from 'paper'
    or jsonb_typeof(new.proposal->'venueAssignments') is distinct from 'array'
    or jsonb_array_length(new.proposal->'venueAssignments') = 0
    or cardinality(new.enabled_turtles) = 0 then raise check_violation using message='invalid_paper_routes'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text,9176401));
  for a in select value from jsonb_array_elements(new.proposal->'venueAssignments') loop
    if not exists(select 1 from public.exchange_connections c where c.id::text=a->>'connectionId'
      and c.user_id=new.user_id) or not coalesce((a->>'symbol')=any(new.symbols),false)
      then raise check_violation using message='invalid_paper_route_owner'; end if;
    -- The existing paper engine owns one campaign per symbol/role. Overlapping
    -- Turtle mandates for a symbol would otherwise silently become ambiguous.
    -- Different Turtles can be compared independently; no live row is consulted.
    if new.status in ('paper_validation','live_eligible') and (
      exists(select 1 from public.autopilot_workflows w
        where w.user_id=new.user_id and w.id<>new.id
          and w.proposal->>'setupBook'='paper' and w.proposal->>'paperRouteVersion'='1'
          and w.status in ('paper_validation','live_eligible')
          and w.enabled_turtles && new.enabled_turtles and (a->>'symbol')=any(w.symbols))
      or exists(select 1 from public.user_strategy s where s.user_id=new.user_id
        and s.mode='paper' and s.enabled and s.symbol=a->>'symbol'
        and coalesce(s.params->>'autopilot_workflow_id','')<>new.id::text
        and (s.params->'enabled_turtles') ?| new.enabled_turtles)
    ) then raise check_violation using message='paper_route_overlap'; end if;
  end loop;
  return new;
end $$;
revoke all on function public.guard_paper_workflow_routes() from public,anon,authenticated;
create trigger guard_paper_workflow_routes before insert or update of status,proposal,enabled_turtles
  on public.autopilot_workflows for each row execute function public.guard_paper_workflow_routes();

-- Retain all existing atomic limits, and recheck the approved route and Turtle
-- under the workflow lock at INSERT (after any asynchronous Council review).
create or replace function public.validate_paper_plan_entry() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare p public.autopilot_workflows%rowtype; local_now timestamp; local_time time; pnl numeric; turtle text;
begin
  if nullif(new.strategy_metadata->>'autopilot_workflow_id','') is null then return new; end if;
  select * into p from public.autopilot_workflows where id::text=new.strategy_metadata->>'autopilot_workflow_id'
    and user_id=new.user_id for update;
  if not found or p.status not in ('paper_validation','live_eligible') or not p.schedule_enabled
    or p.proposal->>'setupBook'='live' then raise exception 'paper_plan_not_active'; end if;
  if exists(select 1 from public.user_strategy where user_id=new.user_id
    and params->>'autopilot_workflow_id'=p.id::text and mode='live') then raise exception 'paper_plan_is_live'; end if;
  if p.proposal->>'paperRouteVersion'='1' and p.proposal->>'setupBook'='paper' then
    if not exists(select 1 from jsonb_array_elements(p.proposal->'venueAssignments') a
      where a->>'symbol'=new.symbol and a->>'connectionId'=new.strategy_metadata->>'autopilot_connection_id')
      then raise exception 'paper_plan_route_changed'; end if;
  else
    perform 1 from public.user_strategy where user_id=new.user_id and mode='paper' and enabled and symbol=new.symbol
      and connection_id::text=new.strategy_metadata->>'autopilot_connection_id'
      and params->>'autopilot_workflow_id'=p.id::text for update;
    if not found then raise exception 'paper_plan_route_changed'; end if;
  end if;
  turtle := coalesce(new.strategy_metadata->>'detector_strategy',new.strategy);
  turtle := case turtle when 'sweep' then 'sniper' when 'rsi-divergence' then 'sniper'
    when 'dca' then 'accumulator' when 'break-retest' then 'vanguard'
    when 'liq-hunting' then 'hunter' when 'funding-arb' then 'arbiter' else turtle end;
  if not coalesce(turtle=any(p.enabled_turtles),false) then raise exception 'paper_plan_turtle_changed'; end if;
  local_now := now() at time zone p.timezone; local_time := local_now::time;
  if not (extract(dow from local_now)::smallint=any(p.active_days)) or
    not (case when p.window_start<=p.window_end then local_time between p.window_start and p.window_end
      else local_time>=p.window_start or local_time<=p.window_end end) then raise exception 'paper_plan_outside_schedule'; end if;
  select coalesce(sum(t.pnl_net),0) into pnl from public.paper_trades t
    join public.paper_positions pos on pos.id=t.position_id and pos.user_id=t.user_id
    where t.user_id=new.user_id and pos.strategy_metadata->>'autopilot_workflow_id'=p.id::text
      and t.closed_at>=p.approved_at;
  if pnl<=-p.loss_limit then raise exception 'paper_plan_loss_limit'; end if;
  if (select count(*) from public.paper_positions where user_id=new.user_id
    and strategy_metadata->>'autopilot_workflow_id'=p.id::text and status='open')>=p.max_open_positions
    then raise exception 'paper_plan_position_cap'; end if;
  if (select count(*) from public.paper_positions where user_id=new.user_id
    and strategy_metadata->>'autopilot_workflow_id'=p.id::text
    and (created_at at time zone p.timezone)::date=local_now::date)>=p.max_daily_entries
    then raise exception 'paper_plan_daily_cap'; end if;
  return new;
end $$;
revoke all on function public.validate_paper_plan_entry() from public,anon,authenticated;

-- Preserve live subscription checks, but allow every Turtle in the paper book.
-- This existing definer RPC is owner-scoped and is necessary because clients
-- cannot write workflows directly. No new privilege or role grant is added.
create or replace function public.edit_autopilot_turtles(
  workflow_id uuid, expected_turtles text[], selected_turtles text[]
) returns void language plpgsql security definer set search_path = '' as $$
declare actor uuid:=auth.uid(); plan public.autopilot_workflows%rowtype;
  entitled text[]; tier_name text; changed integer:=0; is_live boolean;
begin
  if actor is null then raise exception 'Sign in required'; end if;
  if cardinality(selected_turtles) not between 1 and 5 or selected_turtles is null
    or array_position(selected_turtles,null) is not null
    or cardinality(selected_turtles)<>(select count(distinct value) from unnest(selected_turtles) value)
    or not selected_turtles<@array['accumulator','vanguard','sniper','hunter','arbiter']::text[]
    then raise exception 'Choose one or more distinct trading Turtles'; end if;
  select * into plan from public.autopilot_workflows where id=workflow_id and user_id=actor for update;
  if not found or plan.status='archived' then raise exception 'Active plan not found'; end if;
  if plan.enabled_turtles is distinct from expected_turtles then
    raise exception 'Turtle selection changed in another session. Reload before saving'; end if;
  is_live:=coalesce(plan.proposal->>'setupBook'='live',false) or exists(
    select 1 from public.user_strategy where user_id=actor and mode='live'
      and params->>'autopilot_workflow_id'=workflow_id::text);
  select tier::text into tier_name from public.subscriptions where user_id=actor;
  entitled:=case when not is_live or exists(select 1 from public.user_roles where user_id=actor and role::text='admin')
      or tier_name in ('orb','zen') then array['accumulator','vanguard','sniper','hunter','arbiter']
    when tier_name='arc' then array['accumulator','vanguard','sniper']
    when tier_name='ion' then array['accumulator','vanguard'] else array['accumulator'] end;
  if not selected_turtles<@entitled then raise exception 'A selected Turtle is not available for this account'; end if;
  update public.user_strategy set params=jsonb_set(coalesce(params,'{}'::jsonb),'{enabled_turtles}',to_jsonb(selected_turtles)),updated_at=now()
    where user_id=actor and params->>'autopilot_workflow_id'=workflow_id::text;
  get diagnostics changed=row_count;
  if changed=0 and not (coalesce(plan.proposal->>'paperRouteVersion'='1',false) and not is_live) then
    raise exception 'This plan has no execution rows to configure'; end if;
  update public.autopilot_workflows set enabled_turtles=selected_turtles,
    proposal=jsonb_set(coalesce(proposal,'{}'::jsonb),'{enabledTurtles}',to_jsonb(selected_turtles)),updated_at=now()
    where id=workflow_id and user_id=actor;
  insert into public.bot_events(user_id,level,event,detail) values(actor,'info','AUTOPILOT_TURTLES_UPDATED',
    jsonb_build_object('workflow_id',workflow_id,'previous_turtles',expected_turtles,'enabled_turtles',selected_turtles,
      'rows_updated',changed,'book',case when is_live then 'live' else 'paper' end,'execution_authority_changed',false));
end $$;
revoke all on function public.edit_autopilot_turtles(uuid,text[],text[]) from public,anon;
grant execute on function public.edit_autopilot_turtles(uuid,text[],text[]) to authenticated;
