-- Edit only a mandate's Turtle selection. Keep execution authority and all
-- sizing, venue, wallet, scheduling and protection settings unchanged.
create or replace function public.edit_autopilot_turtles(
  workflow_id uuid, expected_turtles text[], selected_turtles text[]
) returns void language plpgsql security definer set search_path = public as $$
declare
  actor uuid := auth.uid();
  plan public.autopilot_workflows%rowtype;
  entitled text[];
  tier_name text;
  changed integer;
begin
  if actor is null then raise exception 'Sign in required'; end if;
  if cardinality(selected_turtles) not between 1 and 5
    or selected_turtles is null or array_position(selected_turtles, null) is not null
    or cardinality(selected_turtles) <> (select count(distinct value) from unnest(selected_turtles) value)
    or not selected_turtles <@ array['accumulator','vanguard','sniper','hunter','arbiter']::text[]
  then raise exception 'Choose one or more distinct trading Turtles'; end if;
  select * into plan from public.autopilot_workflows
    where id = workflow_id and user_id = actor for update;
  if not found or plan.status = 'archived' then raise exception 'Active plan not found'; end if;
  if plan.enabled_turtles is distinct from expected_turtles then
    raise exception 'Turtle selection changed in another session. Reload before saving';
  end if;
  select tier::text into tier_name from public.subscriptions where user_id = actor;
  entitled := case
    when exists(select 1 from public.user_roles where user_id = actor and role::text = 'admin')
      or tier_name in ('orb','zen') then array['accumulator','vanguard','sniper','hunter','arbiter']
    when tier_name = 'arc' then array['accumulator','vanguard','sniper']
    when tier_name = 'ion' then array['accumulator','vanguard']
    else array['accumulator'] end;
  if not selected_turtles <@ entitled then raise exception 'A selected Turtle is not available for this account'; end if;
  update public.user_strategy
    set params = jsonb_set(coalesce(params, '{}'::jsonb), '{enabled_turtles}', to_jsonb(selected_turtles)),
        updated_at = now()
    where user_id = actor and params->>'autopilot_workflow_id' = workflow_id::text;
  get diagnostics changed = row_count;
  if changed = 0 then raise exception 'This plan has no execution rows to configure'; end if;
  update public.autopilot_workflows
    set enabled_turtles = selected_turtles,
        proposal = jsonb_set(coalesce(proposal, '{}'::jsonb), '{enabledTurtles}', to_jsonb(selected_turtles)),
        updated_at = now()
    where id = workflow_id and user_id = actor;
  insert into public.bot_events(user_id, level, event, detail)
    values(actor, 'info', 'AUTOPILOT_TURTLES_UPDATED', jsonb_build_object(
      'workflow_id',workflow_id,'previous_turtles',expected_turtles,
      'enabled_turtles',selected_turtles,'rows_updated',changed,
      'execution_authority_changed',false));
end;
$$;
revoke all on function public.edit_autopilot_turtles(uuid,text[],text[]) from public, anon;
grant execute on function public.edit_autopilot_turtles(uuid,text[],text[]) to authenticated;
