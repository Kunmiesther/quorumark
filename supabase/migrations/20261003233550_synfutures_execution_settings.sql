-- Owner edits retain revision/ownership checks and do not grant trading authority.
CREATE OR REPLACE FUNCTION public.update_autopilot_execution_settings(_actor_id uuid, _workflow_id uuid, _expected_updated_at timestamp with time zone, _leverage integer, _max_daily_entries integer, _max_open_positions integer)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
      and (c.id is null or c.exchange not in ('apex_omni','aster','synfutures') or c.environment not in ('mainnet','production','live')
        or c.status::text <> 'verified' or not coalesce(c.permissions_verified and c.permission_read and c.permission_trade,false)))
    then raise exception 'A plan route is not a verified supported live venue'; end if;
  select min(case when c.exchange='synfutures' then 33 when c.exchange='apex_omni' then 100 else 125 end) into ceiling
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
$function$

