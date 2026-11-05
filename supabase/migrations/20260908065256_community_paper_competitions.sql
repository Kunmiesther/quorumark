-- Private community paper competitions.
-- Campaign Manager owns communications; these tables own eligibility, rules,
-- scoring snapshots, and the audit trail. Public app users are never enrolled.

create table public.community_competitions (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.trading_communities(id) on delete cascade,
  name text not null check (char_length(name) between 3 and 120),
  status text not null default 'draft'
    check (status in ('draft','enrollment','active','auditing','complete','cancelled')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  enrollment_ends_at timestamptz not null,
  max_participants integer not null default 200
    check (max_participants between 2 and 200),
  starting_balance numeric(18,2) not null default 2000
    check (starting_balance > 0),
  max_leverage numeric(8,2) not null default 100
    check (max_leverage between 1 and 100),
  max_trade_risk_bps integer not null default 200
    check (max_trade_risk_bps between 1 and 10000),
  max_portfolio_risk_bps integer not null default 600
    check (max_portfolio_risk_bps between 1 and 10000),
  prize_first_cents integer not null default 30000 check (prize_first_cents >= 0),
  prize_second_cents integer not null default 15000 check (prize_second_cents >= 0),
  prize_third_cents integer not null default 5000 check (prize_third_cents >= 0),
  rules_version text not null default '1.0',
  rules_url text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, community_id),
  constraint community_competitions_schedule check (
    enrollment_ends_at <= starts_at
    and ends_at > starts_at
    and ends_at <= starts_at + interval '43 days'
  ),
  constraint community_competitions_prize_pool check (
    prize_first_cents + prize_second_cents + prize_third_cents = 50000
  )
);

create index community_competitions_community_status_idx
  on public.community_competitions (community_id, status, starts_at desc);

create table public.community_competition_entries (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.community_competitions(id) on delete cascade,
  community_id uuid not null references public.trading_communities(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  leaderboard_name text not null check (char_length(leaderboard_name) between 2 and 40),
  status text not null default 'active'
    check (status in ('active','withdrawn','disqualified','completed')),
  accepted_rules_version text not null,
  accepted_rules_at timestamptz not null default now(),
  integrity_penalty numeric(12,4) not null default 0 check (integrity_penalty >= 0),
  disqualification_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (competition_id, user_id),
  constraint community_competition_entry_scope
    unique (competition_id, community_id, user_id),
  constraint community_competition_entry_competition_scope
    foreign key (competition_id, community_id)
    references public.community_competitions (id, community_id) on delete cascade,
  unique (id, competition_id, user_id)
);

create index community_competition_entries_community_idx
  on public.community_competition_entries (community_id, competition_id, status);
create index community_competition_entries_user_idx
  on public.community_competition_entries (user_id, created_at desc);

-- Only trusted server code writes score snapshots. Keeping each refresh makes
-- final results reproducible instead of silently replacing prior calculations.
create table public.community_competition_score_snapshots (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.community_competitions(id) on delete cascade,
  entry_id uuid not null references public.community_competition_entries(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  ending_balance numeric(18,2) not null,
  return_pct numeric(14,6) not null,
  max_drawdown_pct numeric(14,6) not null,
  liquidation_count integer not null default 0 check (liquidation_count >= 0),
  closed_trade_count integer not null default 0 check (closed_trade_count >= 0),
  integrity_penalty numeric(12,4) not null default 0 check (integrity_penalty >= 0),
  score numeric(18,6) not null,
  calculated_through timestamptz not null,
  created_at timestamptz not null default now(),
  constraint community_competition_score_entry_scope
    foreign key (entry_id, competition_id, user_id)
    references public.community_competition_entries (id, competition_id, user_id) on delete cascade
);

create index community_competition_scores_latest_idx
  on public.community_competition_score_snapshots (competition_id, entry_id, created_at desc);

create table public.community_competition_campaigns (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.community_competitions(id) on delete cascade,
  community_id uuid not null references public.trading_communities(id) on delete cascade,
  phase text not null check (phase in ('launch','reminder','last_call','started','weekly_update','final_results')),
  channel text not null default 'telegram' check (channel in ('telegram')),
  message text not null check (char_length(message) between 1 and 3500),
  image_url text,
  sent_count integer not null default 0 check (sent_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  sent_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint community_competition_campaign_scope
    foreign key (competition_id, community_id)
    references public.community_competitions (id, community_id) on delete cascade
);

create index community_competition_campaigns_competition_idx
  on public.community_competition_campaigns (competition_id, created_at desc);

alter table public.community_competitions enable row level security;
alter table public.community_competition_entries enable row level security;
alter table public.community_competition_score_snapshots enable row level security;
alter table public.community_competition_campaigns enable row level security;

grant select on public.community_competitions to authenticated;
grant select on public.community_competition_entries to authenticated;
grant select on public.community_competition_score_snapshots to authenticated;
grant select on public.community_competition_campaigns to authenticated;
grant all on public.community_competitions to service_role;
grant all on public.community_competition_entries to service_role;
grant all on public.community_competition_score_snapshots to service_role;
grant all on public.community_competition_campaigns to service_role;

create policy "Members read private community competitions"
  on public.community_competitions for select to authenticated
  using (
    public.has_role((select auth.uid()), 'admin')
    or public.is_community_member(community_id)
    or public.is_community_leader(community_id)
  );

create policy "Members read private competition entries"
  on public.community_competition_entries for select to authenticated
  using (
    public.has_role((select auth.uid()), 'admin')
    or public.is_community_member(community_id)
    or public.is_community_leader(community_id)
  );

create policy "Members read private competition scores"
  on public.community_competition_score_snapshots for select to authenticated
  using (
    exists (
      select 1
      from public.community_competition_entries entry
      where entry.id = community_competition_score_snapshots.entry_id
        and (
          public.has_role((select auth.uid()), 'admin')
          or public.is_community_member(entry.community_id)
          or public.is_community_leader(entry.community_id)
        )
    )
  );

create policy "Leaders read competition campaign history"
  on public.community_competition_campaigns for select to authenticated
  using (
    public.has_role((select auth.uid()), 'admin')
    or public.is_community_leader(community_id)
  );

create trigger community_competitions_touch
  before update on public.community_competitions
  for each row execute function public.update_updated_at_column();
create trigger community_competition_entries_touch
  before update on public.community_competition_entries
  for each row execute function public.update_updated_at_column();

create or replace function public.competition_scores_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'COMPETITION_SCORES_APPEND_ONLY';
end;
$$;

create trigger community_competition_scores_append_only
  before update or delete on public.community_competition_score_snapshots
  for each row execute function public.competition_scores_append_only();

create or replace function public.join_community_competition(
  _competition_id uuid,
  _leaderboard_name text,
  _accepted_rules_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid uuid := auth.uid();
  _competition public.community_competitions%rowtype;
  _seat_count integer;
  _entry_id uuid;
begin
  if _uid is null then
    return jsonb_build_object('ok', false, 'reason', 'NOT_AUTHENTICATED');
  end if;

  select * into _competition
  from public.community_competitions
  where id = _competition_id
  for update;

  if not found then return jsonb_build_object('ok', false, 'reason', 'NOT_FOUND'); end if;
  if _competition.status <> 'enrollment' then
    return jsonb_build_object('ok', false, 'reason', 'ENROLLMENT_CLOSED');
  end if;
  if now() > _competition.enrollment_ends_at then
    return jsonb_build_object('ok', false, 'reason', 'ENROLLMENT_CLOSED');
  end if;
  if _accepted_rules_version <> _competition.rules_version then
    return jsonb_build_object('ok', false, 'reason', 'RULES_VERSION_MISMATCH');
  end if;
  if char_length(trim(_leaderboard_name)) not between 2 and 40 then
    return jsonb_build_object('ok', false, 'reason', 'INVALID_LEADERBOARD_NAME');
  end if;
  if not exists (
    select 1 from public.community_memberships membership
    where membership.community_id = _competition.community_id
      and membership.user_id = _uid
      and membership.status = 'active'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'COMMUNITY_MEMBERSHIP_REQUIRED');
  end if;

  select count(*)::integer into _seat_count
  from public.community_competition_entries entry
  where entry.competition_id = _competition.id
    and entry.status in ('active','completed');

  if _seat_count >= _competition.max_participants then
    return jsonb_build_object('ok', false, 'reason', 'COMPETITION_FULL');
  end if;

  insert into public.community_competition_entries (
    competition_id,
    community_id,
    user_id,
    leaderboard_name,
    accepted_rules_version
  ) values (
    _competition.id,
    _competition.community_id,
    _uid,
    trim(_leaderboard_name),
    _competition.rules_version
  )
  on conflict (competition_id, user_id) do update
    set leaderboard_name = excluded.leaderboard_name,
        accepted_rules_version = excluded.accepted_rules_version,
        accepted_rules_at = now(),
        status = 'active',
        updated_at = now()
  returning id into _entry_id;

  insert into public.community_audit_events (community_id, actor_user_id, action, detail)
  values (
    _competition.community_id,
    _uid,
    'competition.joined',
    jsonb_build_object('competition_id', _competition.id, 'entry_id', _entry_id)
  );

  return jsonb_build_object('ok', true, 'reason', 'JOINED', 'entry_id', _entry_id);
end;
$$;

revoke all on function public.join_community_competition(uuid, text, text) from public;
grant execute on function public.join_community_competition(uuid, text, text) to authenticated;

create view public.community_competition_leaderboard
with (security_invoker = true)
as
select distinct on (entry.id)
  entry.competition_id,
  entry.community_id,
  entry.id as entry_id,
  entry.user_id = (select auth.uid()) as is_current_user,
  entry.leaderboard_name,
  entry.status,
  score.ending_balance,
  score.return_pct,
  score.max_drawdown_pct,
  score.liquidation_count,
  score.closed_trade_count,
  score.integrity_penalty,
  score.score,
  score.calculated_through,
  score.created_at as score_created_at
from public.community_competition_entries entry
left join public.community_competition_score_snapshots score
  on score.entry_id = entry.id
order by entry.id, score.created_at desc;

grant select on public.community_competition_leaderboard to authenticated;
