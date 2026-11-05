-- Preserve owner, book, schedule, loss and position limits. Only resolve the
-- strategy's selected execution agent, and record it on newly opened positions.
CREATE OR REPLACE FUNCTION public.validate_paper_plan_entry()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare p public.autopilot_workflows%rowtype; local_now timestamp; local_time time; pnl numeric; turtle text; owner_candidates text[]; requested_owner text;
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
  -- Strategy identity is independent of the selected execution agent.
  owner_candidates := case turtle
    when 'accumulator' then array['accumulator']::text[]
    when 'dca' then array['accumulator']::text[]
    when 'vanguard' then array['vanguard']::text[]
    when 'break-retest' then array['vanguard']::text[]
    when 'sniper' then array['sniper']::text[]
    when 'sweep' then array['sniper','accumulator']::text[]
    when 'rsi-divergence' then array['sniper']::text[]
    when 'hunter' then array['hunter']::text[]
    when 'liq-hunting' then array['hunter']::text[]
    when 'arbiter' then array['arbiter']::text[]
    when 'funding-arb' then array['arbiter']::text[]
    else array[turtle]::text[] end;
  requested_owner := nullif(new.strategy_metadata->>'executing_turtle','');
  if requested_owner is not null then
    if not coalesce(requested_owner=any(owner_candidates)
      and requested_owner=any(p.enabled_turtles),false)
      then raise exception 'paper_plan_turtle_changed'; end if;
    turtle := requested_owner;
  else
    select candidate into turtle from unnest(owner_candidates) with ordinality as owners(candidate,priority)
      where candidate=any(p.enabled_turtles) order by priority limit 1;
  end if;
  if turtle is null then raise exception 'paper_plan_turtle_changed'; end if;
  new.strategy_metadata := jsonb_set(new.strategy_metadata,'{executing_turtle}',to_jsonb(turtle));
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
end $function$
;
