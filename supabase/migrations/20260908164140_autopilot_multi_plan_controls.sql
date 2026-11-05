-- Multiple paper-only Autopilot plans with explicit scheduling and reversible
-- controls. The existing paper engine remains the sole execution authority.

alter table public.autopilot_workflows
  add column if not exists name text,
  add column if not exists schedule_enabled boolean not null default true,
  add column if not exists active_days smallint[] not null default array[0,1,2,3,4,5,6]::smallint[],
  add column if not exists window_start time not null default '00:00',
  add column if not exists window_end time not null default '23:59:59',
  add column if not exists timezone text not null default 'UTC',
  add column if not exists max_daily_entries smallint not null default 1,
  add column if not exists max_open_positions smallint not null default 1,
  add column if not exists paused_at timestamptz,
  add column if not exists pause_reason text,
  add column if not exists archived_at timestamptz;

update public.autopilot_workflows
set name = coalesce(nullif(btrim(name), ''), goal_label)
where name is null or btrim(name) = '';

alter table public.autopilot_workflows
  alter column name set not null;

alter table public.autopilot_workflows
  drop constraint if exists autopilot_workflows_status_check,
  add constraint autopilot_workflows_status_check
    check (status in (
      'draft',
      'awaiting_approval',
      'paper_validation',
      'live_eligible',
      'paused',
      'rejected',
      'archived'
    )),
  add constraint autopilot_workflows_name_check
    check (char_length(btrim(name)) between 1 and 80),
  add constraint autopilot_workflows_active_days_check
    check (
      cardinality(active_days) between 1 and 7
      and active_days <@ array[0,1,2,3,4,5,6]::smallint[]
    ),
  add constraint autopilot_workflows_timezone_check
    check (char_length(btrim(timezone)) between 1 and 80),
  add constraint autopilot_workflows_daily_entries_check
    check (max_daily_entries between 1 and 10),
  add constraint autopilot_workflows_open_positions_check
    check (max_open_positions between 1 and 6);

create index if not exists autopilot_workflows_user_status_idx
  on public.autopilot_workflows (user_id, status, updated_at desc);

comment on column public.autopilot_workflows.authorized_capital is
  'Capital reserved from the shared paper bankroll for this plan. Active reservations are enforced by autopilot-plan.';
comment on column public.autopilot_workflows.schedule_enabled is
  'When false, the plan remains saved but is not eligible for scheduled paper execution.';
comment on column public.autopilot_workflows.active_days is
  'UTC-compatible weekday numbers 0=Sunday through 6=Saturday, interpreted in timezone.';

-- Clients retain read/insert only. State transitions remain server-owned by
-- the authenticated autopilot-plan Edge Function.
revoke update, delete on public.autopilot_workflows from authenticated;
