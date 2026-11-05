-- Restore the existing read-only live Onyx review job's missing ledgers.
-- Advisories are evidence, not execution authority; this changes no orders
-- or open positions.

create table if not exists public.live_position_advisories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  position_id uuid not null,
  symbol text not null,
  direction text not null,
  candle_close_at timestamptz not null,
  trace_id uuid not null,
  evidence_hash text not null,
  snapshot jsonb not null default '{}'::jsonb,
  seats_total integer not null default 0,
  seats_available integer not null default 0,
  consensus_action text not null default 'no_change',
  consensus_confidence numeric,
  risk_check jsonb not null default '{}'::jsonb,
  narrative text not null default '',
  advisory boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint live_position_advisories_unique_candle unique (position_id, candle_close_at)
);

create index if not exists live_position_advisories_user_recent_idx
  on public.live_position_advisories (user_id, candle_close_at desc);

create table if not exists public.live_position_advisory_opinions (
  id uuid primary key default gen_random_uuid(),
  advisory_id uuid not null references public.live_position_advisories(id) on delete cascade,
  user_id uuid not null,
  role text not null,
  provider text not null,
  model text not null,
  available boolean not null,
  unavailable_reason text,
  detail text,
  latency_ms integer not null default 0,
  action text,
  confidence numeric,
  risk_flags jsonb not null default '[]'::jsonb,
  rationale text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists live_position_advisory_opinions_advisory_idx
  on public.live_position_advisory_opinions (advisory_id);

grant select on public.live_position_advisories to authenticated;
grant all on public.live_position_advisories to service_role;
grant select on public.live_position_advisory_opinions to authenticated;
grant all on public.live_position_advisory_opinions to service_role;
alter table public.live_position_advisories enable row level security;
alter table public.live_position_advisory_opinions enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
    and tablename='live_position_advisories' and policyname='own live advisories readable') then
    create policy "own live advisories readable"
      on public.live_position_advisories for select to authenticated
      using ((select auth.uid()) = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
    and tablename='live_position_advisory_opinions' and policyname='own live advisory opinions readable') then
    create policy "own live advisory opinions readable"
      on public.live_position_advisory_opinions for select to authenticated
      using ((select auth.uid()) = user_id);
  end if;
  if not exists (select 1 from pg_trigger where tgname='live_position_advisories_touch'
    and tgrelid='public.live_position_advisories'::regclass) then
    create trigger live_position_advisories_touch
      before update on public.live_position_advisories
      for each row execute function public.update_updated_at_column();
  end if;
end $$;
