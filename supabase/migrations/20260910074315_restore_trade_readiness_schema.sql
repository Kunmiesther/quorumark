-- Restore the advisory market-scan ledger used by Onyx and the Trust Center.
-- These tables are read-only to signed-in users and writable only by the
-- service role. AI output remains advisory and cannot authorize execution.

create table public.committee_cycles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  cycle_key text not null,
  book text not null default 'paper',
  candle_close_at timestamptz not null,
  status text not null default 'reviewing',
  universe_size integer not null default 0,
  candidate_count integer not null default 0,
  reviewed_count integer not null default 0,
  seat_response_count integer not null default 0,
  selected_symbol text,
  selected_direction text,
  selected_score numeric,
  no_trade_reason text,
  strategy_version text not null default 'shortlist.v1',
  geometry_version text,
  provenance jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint committee_cycles_user_cycle_key unique (user_id, cycle_key)
);

create table public.committee_shortlist (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.committee_cycles(id) on delete cascade,
  user_id uuid not null,
  symbol text not null,
  direction text not null,
  state text not null default 'reviewing',
  rank integer,
  total_score numeric,
  score_components jsonb not null default '{}'::jsonb,
  liquidity_usd numeric,
  spread_bps numeric,
  volatility_pct numeric,
  expected_net_edge_bps numeric,
  seat_decisions jsonb not null default '[]'::jsonb,
  available_seats integer not null default 0,
  unavailable_seats integer not null default 0,
  verdict text,
  consensus_confidence numeric,
  risk_veto boolean not null default false,
  rejection_reason text,
  candidate_id text,
  evaluation_id uuid,
  evidence_hash text,
  signal_id uuid,
  entry_plan jsonb not null default '{}'::jsonb,
  risk_objection jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint committee_shortlist_unique_side unique (cycle_id, symbol, direction)
);

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
  outcomes jsonb not null default '[]'::jsonb,
  verdict text not null,
  consensus_direction text,
  consensus_confidence numeric,
  risk_flags text[] not null default '{}',
  available_roles text[] not null default '{}',
  unavailable_roles text[] not null default '{}',
  total_latency_ms integer,
  advisory boolean not null default true,
  risk_dissent boolean not null default false,
  prompt_version text not null default 'prompt.v1',
  scorer_version text not null default 'scorer.v1',
  shadow_score numeric,
  score_band text,
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
  constraint ai_committee_score_band_ck check (
    score_band is null or score_band in ('strong','moderate','weak','avoid','insufficient')
  ),
  constraint ai_committee_unique_eval unique (user_id, candidate_id, evidence_hash)
);

create table public.strategy_candidates (
  candidate_id text primary key,
  user_id uuid not null,
  connection_id uuid,
  strategy text not null,
  symbol text not null,
  timeframe text not null,
  direction text not null check (direction in ('long','short')),
  candle_close_at timestamptz not null,
  market_data_at timestamptz,
  freshness_ms integer,
  entry_zone jsonb,
  invalidation numeric,
  tp_ladder jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  evidence_hash text not null,
  schema_version text not null default 'candidate.v1',
  technical_decision text not null default 'technical_validated'
    check (technical_decision in ('technical_validated','technical_rejected')),
  technical_reason text,
  idempotency_key text,
  ai_shadow_state text not null default 'ai_shadow_pending'
    check (ai_shadow_state in ('ai_shadow_pending','ai_shadow_evaluated','ai_shadow_unavailable')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.committee_cycles enable row level security;
alter table public.committee_shortlist enable row level security;
alter table public.ai_committee_evaluations enable row level security;
alter table public.strategy_candidates enable row level security;

grant select on public.committee_cycles to authenticated;
grant select on public.committee_shortlist to authenticated;
grant select on public.ai_committee_evaluations to authenticated;
grant select on public.strategy_candidates to authenticated;
grant all on public.committee_cycles to service_role;
grant all on public.committee_shortlist to service_role;
grant all on public.ai_committee_evaluations to service_role;
grant all on public.strategy_candidates to service_role;

create policy "Owners read own committee cycles"
  on public.committee_cycles for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Service role manages committee cycles"
  on public.committee_cycles for all to service_role
  using (true) with check (true);
create policy "Owners read own committee shortlist"
  on public.committee_shortlist for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Service role manages committee shortlist"
  on public.committee_shortlist for all to service_role
  using (true) with check (true);
create policy "Users read their own committee evaluations"
  on public.ai_committee_evaluations for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Owners read their own candidates"
  on public.strategy_candidates for select to authenticated
  using ((select auth.uid()) = user_id);

create index committee_cycles_user_recent_idx
  on public.committee_cycles (user_id, candle_close_at desc);
create index committee_shortlist_cycle_rank_idx
  on public.committee_shortlist (cycle_id, rank nulls last);
create index committee_shortlist_user_recent_idx
  on public.committee_shortlist (user_id, created_at desc);
create index ai_committee_eval_lookup_idx
  on public.ai_committee_evaluations (user_id, symbol, candle_close_at desc);
create index strategy_candidates_user_symbol_idx
  on public.strategy_candidates (user_id, symbol, candle_close_at desc);
create index strategy_candidates_evidence_hash_idx
  on public.strategy_candidates (evidence_hash);
create index strategy_candidates_idem_idx
  on public.strategy_candidates (idempotency_key);

create trigger committee_cycles_touch
  before update on public.committee_cycles
  for each row execute function public.update_updated_at_column();
create trigger committee_shortlist_touch
  before update on public.committee_shortlist
  for each row execute function public.update_updated_at_column();
create trigger strategy_candidates_touch
  before update on public.strategy_candidates
  for each row execute function public.update_updated_at_column();
