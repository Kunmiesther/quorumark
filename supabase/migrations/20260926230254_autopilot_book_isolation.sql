-- No live row is enabled, disabled or repriced by this migration.
-- Preserve strategy metadata in the existing atomic paper open, including its guards.
do $$
declare source text;
begin
  source := pg_get_functiondef('public.paper_open_position(uuid,uuid,jsonb)'::regprocedure);
  if position('strategy_metadata' in source) = 0 then
    if position('trend_slope_pct_at_entry, strategy,' in source) = 0
       or position('coalesce(nullif(_payload->>''strategy'', ''''), ''accumulator''),' in source) = 0 then
      raise exception 'Unexpected paper_open_position definition; review before migration';
    end if;
    source := replace(source, 'trend_slope_pct_at_entry, strategy,', 'trend_slope_pct_at_entry, strategy, strategy_metadata,');
    source := replace(source, 'coalesce(nullif(_payload->>''strategy'', ''''), ''accumulator''),',
      'coalesce(nullif(_payload->>''strategy'', ''''), ''accumulator''), coalesce(_payload->''strategy_metadata'', ''{}''::jsonb),');
    execute source;
  end if;
end $$;

alter table public.autopilot_workflows drop constraint if exists autopilot_workflows_status_check;
alter table public.autopilot_workflows add constraint autopilot_workflows_status_check
  check (status in ('draft','awaiting_approval','paper_validation','live_eligible','live_configured','paused','rejected','archived'));

-- Only the authenticated Edge handler and service worker may call this function.
-- SECURITY INVOKER does not elevate access. A transaction contains all mutations and audit.
create or replace function public.control_autopilot_plan(
  _user_id uuid, _workflow_id uuid, _action text, _expected_status text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  p public.autopilot_workflows%rowtype;
  is_live boolean;
  next_status text;
  realized numeric;
begin
  select * into p from public.autopilot_workflows
    where id = _workflow_id and user_id = _user_id for update;
  if not found then raise exception 'plan_not_found'; end if;
  if p.status is distinct from _expected_status then raise exception 'plan_changed'; end if;
  perform 1 from public.user_strategy where user_id = _user_id
    and params->>'autopilot_workflow_id' = _workflow_id::text order by connection_id,symbol for update;
  is_live := coalesce(p.proposal->>'setupBook' = 'live', false) or exists (
    select 1 from public.user_strategy where user_id = _user_id
      and params->>'autopilot_workflow_id' = _workflow_id::text and mode = 'live');
  if _action not in ('pause','archive','resume_paper','paper_loss_pause') then raise exception 'invalid_plan_action'; end if;
  if _action in ('resume_paper','paper_loss_pause') and is_live then raise exception 'live_plan_not_paper'; end if;
  if _action = 'resume_paper' and p.status <> 'paused' then raise exception 'plan_not_paused'; end if;
  if _action = 'paper_loss_pause' then
    if p.status not in ('paper_validation','live_eligible') then raise exception 'plan_not_paper'; end if;
    select coalesce(sum(t.pnl_net),0) into realized from public.paper_trades t
      join public.paper_positions pos on pos.id = t.position_id and pos.user_id = t.user_id
      where t.user_id = _user_id and pos.strategy_metadata->>'autopilot_workflow_id' = _workflow_id::text
        and t.closed_at >= p.approved_at;
    if realized > -p.loss_limit then return jsonb_build_object('status',p.status,'changed',false); end if;
  end if;
  next_status := case when _action = 'resume_paper' then 'paper_validation'
    when _action = 'archive' then 'archived' else 'paused' end;
  update public.user_strategy set enabled = (_action = 'resume_paper'), updated_at = now()
    where user_id = _user_id and params->>'autopilot_workflow_id' = _workflow_id::text
      and (_action not in ('resume_paper','paper_loss_pause') or mode = 'paper');
  -- Archive keeps execution rows disabled for traceability instead of deleting identities.
  update public.autopilot_workflows set status = next_status,
    paused_at = case when next_status = 'paused' then now() else null end,
    pause_reason = case when _action = 'paper_loss_pause' then 'Attributed paper loss limit reached'
      when _action = 'pause' then 'Paused by user' else null end,
    archived_at = case when next_status = 'archived' then now() else null end, updated_at = now()
    where id = _workflow_id and user_id = _user_id;
  insert into public.autopilot_risk_events(workflow_id,user_id,code,detail) values (
    _workflow_id,_user_id,case when _action = 'paper_loss_pause' then 'loss_limit_reached' else 'plan_control' end,
    jsonb_build_object('action',_action,'book',case when is_live then 'live' else 'paper' end,
      'previousStatus',p.status,'status',next_status,'realizedPnl',realized,'lossLimit',p.loss_limit,
      'attribution','position_workflow_id'));
  return jsonb_build_object('status',next_status,'changed',true);
end $$;
revoke all on function public.control_autopilot_plan(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.control_autopilot_plan(uuid,uuid,text,text) to service_role;

-- A stale candidate cannot open after its plan/row was paused while AI was evaluating it.
create or replace function public.validate_paper_plan_entry() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare p public.autopilot_workflows%rowtype; local_now timestamp; local_time time; pnl numeric;
begin
  if nullif(new.strategy_metadata->>'autopilot_workflow_id','') is null then return new; end if;
  select * into p from public.autopilot_workflows where id::text = new.strategy_metadata->>'autopilot_workflow_id'
    and user_id = new.user_id for update;
  if not found or p.status not in ('paper_validation','live_eligible') or not p.schedule_enabled
    or p.proposal->>'setupBook' = 'live' then raise exception 'paper_plan_not_active'; end if;
  if exists(select 1 from public.user_strategy where user_id=new.user_id
    and params->>'autopilot_workflow_id'=p.id::text and mode='live') then raise exception 'paper_plan_is_live'; end if;
  perform 1 from public.user_strategy where user_id = new.user_id and mode='paper' and enabled and symbol=new.symbol
    and connection_id::text = new.strategy_metadata->>'autopilot_connection_id'
    and params->>'autopilot_workflow_id'=p.id::text for update;
  if not found then raise exception 'paper_plan_route_changed'; end if;
  local_now := now() at time zone p.timezone; local_time := local_now::time;
  if not (extract(dow from local_now)::smallint = any(p.active_days)) or
    not (case when p.window_start <= p.window_end then local_time between p.window_start and p.window_end
      else local_time >= p.window_start or local_time <= p.window_end end) then raise exception 'paper_plan_outside_schedule'; end if;
  select coalesce(sum(t.pnl_net),0) into pnl from public.paper_trades t
    join public.paper_positions pos on pos.id=t.position_id and pos.user_id=t.user_id
    where t.user_id=new.user_id and pos.strategy_metadata->>'autopilot_workflow_id'=p.id::text
      and t.closed_at>=p.approved_at;
  if pnl <= -p.loss_limit then raise exception 'paper_plan_loss_limit'; end if;
  if (select count(*) from public.paper_positions where user_id=new.user_id
    and strategy_metadata->>'autopilot_workflow_id'=p.id::text and status='open') >= p.max_open_positions
    then raise exception 'paper_plan_position_cap'; end if;
  if (select count(*) from public.paper_positions where user_id=new.user_id
    and strategy_metadata->>'autopilot_workflow_id'=p.id::text
    and (created_at at time zone p.timezone)::date=local_now::date) >= p.max_daily_entries
    then raise exception 'paper_plan_daily_cap'; end if;
  return new;
end $$;
revoke all on function public.validate_paper_plan_entry() from public,anon,authenticated;
drop trigger if exists validate_paper_plan_entry on public.paper_positions;
create trigger validate_paper_plan_entry before insert on public.paper_positions
  for each row execute function public.validate_paper_plan_entry();

-- Repair only demonstrably misclassified legacy pauses. Never touch execution settings.
with affected as (
  select w.id,w.user_id,w.status,w.pause_reason,w.validation from public.autopilot_workflows w
  where w.status='paused' and w.pause_reason='Automatic loss limit reached'
    and exists(select 1 from public.user_strategy s where s.user_id=w.user_id
      and s.params->>'autopilot_workflow_id'=w.id::text and s.mode='live' and s.enabled)
    and exists(select 1 from public.autopilot_risk_events e where e.workflow_id=w.id
      and e.user_id=w.user_id and e.code='loss_limit_reached' and not (e.detail ? 'book'))
), audited as (
  insert into public.autopilot_risk_events(workflow_id,user_id,code,detail)
    select id,user_id,'legacy_paper_pause_reconciled',jsonb_build_object('previousStatus',status,
      'previousReason',pause_reason,'previousValidation',validation,'executionSettingsChanged',false) from affected
    returning workflow_id,user_id
)
update public.autopilot_workflows w set status='live_configured',paused_at=null,pause_reason=null,
  proposal=coalesce(w.proposal,'{}'::jsonb)||'{"setupBook":"live"}'::jsonb,
  validation=jsonb_build_object('note','Legacy paper evidence was not plan-attributed; archived in the reconciliation audit.'),
  updated_at=now() from audited a where w.id=a.workflow_id and w.user_id=a.user_id;
