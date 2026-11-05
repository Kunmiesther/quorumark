-- Targeted production reconciliation for the paper orchestration audit trail.
--
-- Production was restored from a runtime snapshot whose migration ledger did
-- not include the August orchestration foundation. This migration restores
-- only those missing objects. It is deliberately idempotent and does not
-- delete or rewrite paper account, wallet, position, or trade rows.

create table if not exists public.paper_ai_orchestrations (
  trace_id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  candidate_key text not null,
  symbol text not null,
  direction text not null check (direction in ('long', 'short')),
  strategy text not null,
  timeframe text not null default '15m',
  candle_ts_ms bigint not null default 0,
  evidence jsonb not null default '{}'::jsonb,
  evidence_hash text not null,
  prompt_version text,
  providers_attempted integer not null default 0,
  providers_answered integer not null default 0,
  participation text not null default 'ai_unavailable'
    check (participation in (
      'full_3_of_3', 'degraded_2_of_3', 'degraded_1_of_3', 'ai_unavailable'
    )),
  degraded boolean not null default false,
  degraded_reason text,
  committee_verdict text,
  onyx_decision text not null default 'wait'
    check (onyx_decision in ('enter', 'wait', 'reject')),
  onyx_rationale text not null default '',
  onyx_confidence numeric,
  onyx_decision_id uuid,
  risk_checked boolean not null default false,
  risk_passed boolean not null default false,
  risk_code text,
  risk_detail jsonb,
  terminal_outcome text not null default 'NO_TRADE_STRATEGY'
    check (terminal_outcome in (
      'TRADE_CANDIDATE', 'NO_TRADE_STRATEGY', 'NO_TRADE_RISK',
      'NO_TRADE_DATA', 'PIPELINE_ERROR'
    )),
  gate_allowed boolean not null default false,
  paper_position_id uuid,
  paper_trade_id uuid,
  snapshot_valid boolean not null default true,
  snapshot_invalid_code text,
  snapshot_detail jsonb,
  record_kind text not null default 'runtime'
    check (record_kind in ('runtime', 'replay', 'backfill')),
  corrected_at timestamptz,
  correction_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint paper_ai_orchestrations_invalid_snapshot_never_allows
    check (snapshot_valid or (
      gate_allowed = false and coalesce(risk_passed, false) = false
    ))
);

create unique index if not exists paper_ai_orch_unique_candidate
  on public.paper_ai_orchestrations (user_id, candidate_key, evidence_hash);
create index if not exists paper_ai_orch_user_created_idx
  on public.paper_ai_orchestrations (user_id, created_at desc);
create index if not exists paper_ai_orch_gate_idx
  on public.paper_ai_orchestrations (user_id, symbol, direction, created_at desc);
create index if not exists paper_ai_orch_position_idx
  on public.paper_ai_orchestrations (paper_position_id);
create index if not exists paper_ai_orchestrations_record_kind_idx
  on public.paper_ai_orchestrations (record_kind, created_at desc);

alter table public.paper_ai_orchestrations enable row level security;
revoke all on table public.paper_ai_orchestrations from public, anon, authenticated;
grant select on table public.paper_ai_orchestrations to authenticated;
grant all on table public.paper_ai_orchestrations to service_role;

drop policy if exists "own orchestrations readable"
  on public.paper_ai_orchestrations;
create policy "own orchestrations readable"
  on public.paper_ai_orchestrations
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create table if not exists public.paper_ai_opinions (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid not null
    references public.paper_ai_orchestrations(trace_id) on delete cascade,
  user_id uuid not null,
  role text not null,
  provider text not null,
  model text not null,
  status text not null check (status in ('evaluated', 'unavailable')),
  direction text check (direction is null or direction in ('long', 'short', 'wait')),
  confidence numeric,
  summary text,
  risk_flags text[] not null default '{}',
  latency_ms integer,
  prompt_version text,
  unavailable_reason text,
  advisory boolean not null default true check (advisory),
  created_at timestamptz not null default now()
);

create unique index if not exists paper_ai_opinions_unique_seat
  on public.paper_ai_opinions (trace_id, role);
create index if not exists paper_ai_opinions_user_idx
  on public.paper_ai_opinions (user_id, created_at desc);

alter table public.paper_ai_opinions enable row level security;
revoke all on table public.paper_ai_opinions from public, anon, authenticated;
grant select on table public.paper_ai_opinions to authenticated;
grant all on table public.paper_ai_opinions to service_role;

drop policy if exists "own opinions readable" on public.paper_ai_opinions;
create policy "own opinions readable"
  on public.paper_ai_opinions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

alter table public.paper_positions
  add column if not exists orchestration_trace_id uuid,
  add column if not exists onyx_decision_id uuid;
alter table public.paper_trades
  add column if not exists orchestration_trace_id uuid,
  add column if not exists onyx_decision_id uuid;

create index if not exists paper_positions_trace_idx
  on public.paper_positions (orchestration_trace_id);
create index if not exists paper_trades_trace_idx
  on public.paper_trades (orchestration_trace_id);

create or replace function public.paper_ai_orchestrations_provenance_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_initial_finalize boolean := false;
begin
  if tg_op = 'INSERT' then
    if new.evidence_hash is null or new.evidence_hash !~ '^[0-9a-f]{64}$' then
      raise exception 'ORCHESTRATION_EVIDENCE_HASH_INVALID';
    end if;
    if new.evidence is null then
      raise exception 'ORCHESTRATION_EVIDENCE_REQUIRED';
    end if;
    if new.candidate_key is null or new.candle_ts_ms is null then
      raise exception 'ORCHESTRATION_CANDIDATE_BINDING_REQUIRED';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if new.trace_id is distinct from old.trace_id
      or new.user_id is distinct from old.user_id
      or new.candidate_key is distinct from old.candidate_key
      or new.symbol is distinct from old.symbol
      or new.direction is distinct from old.direction
      or new.strategy is distinct from old.strategy
      or new.candle_ts_ms is distinct from old.candle_ts_ms
      or new.evidence_hash is distinct from old.evidence_hash
      or new.evidence is distinct from old.evidence
      or new.record_kind is distinct from old.record_kind
    then
      raise exception 'ORCHESTRATION_PROVENANCE_IMMUTABLE';
    end if;

    v_initial_finalize :=
      old.gate_allowed = false
      and old.onyx_decision = 'wait'
      and old.terminal_outcome = 'NO_TRADE_STRATEGY'
      and old.risk_checked = false
      and old.risk_passed = false
      and old.providers_answered = 0
      and old.paper_position_id is null
      and old.corrected_at is null;

    if old.gate_allowed = false and new.gate_allowed = true
      and not v_initial_finalize
    then
      raise exception 'ORCHESTRATION_REAUTHORIZATION_FORBIDDEN';
    end if;
    if old.snapshot_valid = false and new.snapshot_valid = true then
      raise exception 'ORCHESTRATION_SNAPSHOT_REVALIDATION_FORBIDDEN';
    end if;
  end if;

  if new.gate_allowed = true then
    if new.snapshot_valid is not true then
      raise exception 'ORCHESTRATION_GATE_REQUIRES_VALID_SNAPSHOT';
    end if;
    if new.record_kind <> 'runtime' then
      raise exception 'ORCHESTRATION_GATE_REQUIRES_RUNTIME_RECORD';
    end if;
    if coalesce(new.providers_attempted, 0) < 3 then
      raise exception 'ORCHESTRATION_GATE_REQUIRES_THREE_PROVIDER_ATTEMPTS';
    end if;
    if new.risk_checked is not true or new.risk_passed is not true then
      raise exception 'ORCHESTRATION_GATE_REQUIRES_PASSED_RISK_CHECK';
    end if;
    if new.onyx_decision <> 'enter'
      or new.terminal_outcome <> 'TRADE_CANDIDATE'
    then
      raise exception 'ORCHESTRATION_GATE_REQUIRES_ENTER_TRADE_CANDIDATE';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.paper_ai_orchestrations_provenance_guard()
  from public, anon, authenticated;
grant execute on function public.paper_ai_orchestrations_provenance_guard()
  to service_role;

drop trigger if exists paper_ai_orchestrations_provenance_guard_trg
  on public.paper_ai_orchestrations;
create trigger paper_ai_orchestrations_provenance_guard_trg
  before insert or update on public.paper_ai_orchestrations
  for each row execute function public.paper_ai_orchestrations_provenance_guard();

create or replace function public.paper_positions_bind_orchestration()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.orchestration_trace_id is not null then
    update public.paper_ai_orchestrations
       set paper_position_id = new.id, updated_at = now()
     where trace_id = new.orchestration_trace_id
       and paper_position_id is null;
  end if;
  return null;
end;
$$;

revoke all on function public.paper_positions_bind_orchestration()
  from public, anon, authenticated;
grant execute on function public.paper_positions_bind_orchestration()
  to service_role;

drop trigger if exists paper_positions_bind_orchestration_trg
  on public.paper_positions;
create trigger paper_positions_bind_orchestration_trg
  after insert on public.paper_positions
  for each row execute function public.paper_positions_bind_orchestration();

create or replace function public.paper_trades_inherit_orchestration()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trace uuid;
  v_onyx uuid;
begin
  if new.orchestration_trace_id is null and new.position_id is not null then
    select p.orchestration_trace_id, p.onyx_decision_id
      into v_trace, v_onyx
      from public.paper_positions p
     where p.id = new.position_id;
    new.orchestration_trace_id := v_trace;
    if new.onyx_decision_id is null then
      new.onyx_decision_id := v_onyx;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.paper_trades_inherit_orchestration()
  from public, anon, authenticated;
grant execute on function public.paper_trades_inherit_orchestration()
  to service_role;

drop trigger if exists paper_trades_inherit_orchestration_trg
  on public.paper_trades;
create trigger paper_trades_inherit_orchestration_trg
  before insert on public.paper_trades
  for each row execute function public.paper_trades_inherit_orchestration();

create or replace function public.paper_trades_bind_orchestration()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.orchestration_trace_id is not null then
    update public.paper_ai_orchestrations
       set paper_trade_id = new.id, updated_at = now()
     where trace_id = new.orchestration_trace_id;
  end if;
  return null;
end;
$$;

revoke all on function public.paper_trades_bind_orchestration()
  from public, anon, authenticated;
grant execute on function public.paper_trades_bind_orchestration()
  to service_role;

drop trigger if exists paper_trades_bind_orchestration_trg
  on public.paper_trades;
create trigger paper_trades_bind_orchestration_trg
  after insert on public.paper_trades
  for each row execute function public.paper_trades_bind_orchestration();

create or replace view public.paper_ai_participation_metrics
with (security_invoker = true) as
select
  o.user_id,
  count(*) filter (where o.participation = 'full_3_of_3') as full_3_of_3,
  count(*) filter (where o.participation = 'degraded_2_of_3') as degraded_2_of_3,
  count(*) filter (where o.participation = 'degraded_1_of_3') as degraded_1_of_3,
  count(*) filter (where o.participation = 'ai_unavailable') as ai_unavailable,
  count(*) filter (where o.terminal_outcome = 'TRADE_CANDIDATE') as trade_candidates,
  count(*) filter (where o.onyx_decision = 'wait') as wait_decisions,
  count(*) as orchestrations,
  (
    select count(*)
      from public.paper_positions p
     where p.user_id = o.user_id
       and p.orchestration_trace_id is null
       and p.created_at > now() - interval '30 days'
  ) as missing_trace_violations
from public.paper_ai_orchestrations o
where o.created_at > now() - interval '30 days'
group by o.user_id;

revoke all on table public.paper_ai_participation_metrics
  from public, anon, authenticated;
grant select on table public.paper_ai_participation_metrics
  to authenticated, service_role;
