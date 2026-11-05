-- All mutations are server-owned. The trigger is the final atomic guard
-- against concurrent approvals or resumes overbooking the shared simulator.

revoke insert, update, delete on public.autopilot_workflows from authenticated;

create or replace function public.guard_autopilot_capital_reservation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_reserved numeric(18, 2);
  v_active_count integer;
begin
  if new.status not in ('paper_validation', 'live_eligible') then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.user_id::text, 9176401)
  );

  select coalesce(sum(w.authorized_capital), 0), count(*)
    into v_reserved, v_active_count
  from public.autopilot_workflows as w
  where w.user_id = new.user_id
    and w.status in ('paper_validation', 'live_eligible')
    and w.id <> new.id;

  if v_active_count >= 5 then
    raise exception 'autopilot_active_plan_limit'
      using errcode = 'check_violation';
  end if;

  if v_reserved + new.authorized_capital > 3600 then
    raise exception 'autopilot_shared_capital_exceeded'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_autopilot_capital_reservation() from public, anon, authenticated;

drop trigger if exists guard_autopilot_capital_reservation
  on public.autopilot_workflows;

create trigger guard_autopilot_capital_reservation
before insert or update of status, authorized_capital
on public.autopilot_workflows
for each row execute function public.guard_autopilot_capital_reservation();
