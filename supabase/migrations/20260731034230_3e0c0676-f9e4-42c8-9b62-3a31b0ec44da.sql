create table public.ai_committee_evaluations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  candidate_id text not null,
  strategy text not null,
  symbol text not null,
  timeframe text not null,
  candle_close_at timestamptz not null,
  schema_version text not null,
  evidence_hash text not null,
  snapshot jsonb not null,
  -- one row per candidate+evidence: replaying the same candle is idempotent
  outcomes jsonb not null default '[]'::jsonb,
  verdict text not null,
  consensus_direction text,
  consensus_confidence numeric,
  risk_flags text[] not null default '{}',
  available_roles text[] not null default '{}',
  unavailable_roles text[] not null default '{}',
  total_latency_ms integer,
  -- SHADOW MODE invariant: this row can never be marked as authoritative.
  advisory boolean not null default true,
  realized_outcome text,
  realized_pnl numeric,
  realized_at timestamptz,
  created_at timestamptz not null default now(),
  constraint ai_committee_advisory_only check (advisory is true),
  constraint ai_committee_verdict_ck check (verdict in (
    'shadow_endorse','shadow_weak_endorse','shadow_reject',
    'shadow_no_consensus','shadow_unavailable'
  )),
  constraint ai_committee_direction_ck check (
    consensus_direction is null or consensus_direction in ('long','short','no_trade')
  ),
  constraint ai_committee_unique_eval unique (user_id, candidate_id, evidence_hash)
);

grant select, insert on public.ai_committee_evaluations to authenticated;
grant all on public.ai_committee_evaluations to service_role;

alter table public.ai_committee_evaluations enable row level security;

create policy "Users read their own committee evaluations"
  on public.ai_committee_evaluations for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users insert their own committee evaluations"
  on public.ai_committee_evaluations for insert
  to authenticated
  with check (auth.uid() = user_id);

create index ai_committee_eval_lookup_idx
  on public.ai_committee_evaluations (user_id, symbol, candle_close_at desc);