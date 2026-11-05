-- Restore the minimum community and Telegram campaign foundation required by
-- the current application. This deliberately excludes legacy paper-wallet and
-- strategy backfills that do not match the active Turtlebot v1 schema.

do $$ begin create type public.community_status as enum ('applied','approved','suspended','revoked'); exception when duplicate_object then null; end $$;
do $$ begin create type public.community_member_role as enum ('member','leader'); exception when duplicate_object then null; end $$;
do $$ begin create type public.community_member_status as enum ('active','suspended','removed'); exception when duplicate_object then null; end $$;
do $$ begin create type public.entitlement_source as enum ('grandfathered','invitation','admin_grant'); exception when duplicate_object then null; end $$;

create table public.trading_communities (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  logo_url text,
  status public.community_status not null default 'applied',
  plan_key text not null default 'free_paper_trial',
  seat_limit integer not null default 0 check (seat_limit >= 0),
  leader_user_id uuid references auth.users(id) on delete set null,
  applicant_email text not null,
  applicant_note text,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.community_memberships (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.trading_communities(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.community_member_role not null default 'member',
  status public.community_member_status not null default 'active',
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (community_id, user_id)
);
create index community_memberships_user_idx on public.community_memberships (user_id, status);

create table public.community_invitations (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.trading_communities(id) on delete cascade,
  token_hash text not null unique,
  email text,
  plan_key text not null default 'free_paper_trial',
  max_uses integer not null default 1 check (max_uses >= 1),
  uses integer not null default 0 check (uses between 0 and max_uses),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index community_invitations_community_idx on public.community_invitations (community_id, created_at desc);

create table public.invitation_redemptions (
  id uuid primary key default gen_random_uuid(),
  invitation_id uuid not null references public.community_invitations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  community_id uuid not null references public.trading_communities(id) on delete cascade,
  redeemed_at timestamptz not null default now(),
  unique (invitation_id, user_id)
);

create table public.access_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_key text not null,
  source public.entitlement_source not null,
  community_id uuid references public.trading_communities(id) on delete set null,
  status text not null default 'active' check (status in ('active','revoked','expired')),
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, plan_key)
);
create index access_entitlements_user_status_idx on public.access_entitlements (user_id, status);

create table public.community_commission_ledger (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.trading_communities(id) on delete cascade,
  period_start date not null,
  period_end date not null check (period_end >= period_start),
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null default 'USD',
  source text not null default 'pending_provider',
  created_at timestamptz not null default now()
);

create table public.community_audit_events (
  id uuid primary key default gen_random_uuid(),
  community_id uuid references public.trading_communities(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index community_audit_events_community_idx on public.community_audit_events (community_id, created_at desc);

create table public.telegram_link_codes (
  code text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.telegram_accounts (
  chat_id bigint primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  telegram_username text,
  telegram_first_name text,
  linked_at timestamptz not null default now()
);

create table public.telegram_broadcast_targets (
  chat_id bigint primary key,
  title text,
  chat_type text not null,
  registered_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create or replace function public.is_community_leader(_community_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.trading_communities community
    where community.id = _community_id and community.leader_user_id = (select auth.uid())
  ) or exists (
    select 1 from public.community_memberships membership
    where membership.community_id = _community_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'leader'
      and membership.status = 'active'
  );
$$;

create or replace function public.is_community_member(_community_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.community_memberships membership
    where membership.community_id = _community_id
      and membership.user_id = (select auth.uid())
      and membership.status = 'active'
  );
$$;

revoke all on function public.is_community_leader(uuid) from public;
revoke all on function public.is_community_member(uuid) from public;
grant execute on function public.is_community_leader(uuid) to authenticated, service_role;
grant execute on function public.is_community_member(uuid) to authenticated, service_role;

create or replace function public.trading_communities_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' and not public.has_role((select auth.uid()), 'admin') then
    new.status := 'applied';
    new.seat_limit := 0;
    new.leader_user_id := null;
    new.approved_by := null;
    new.approved_at := null;
  elsif tg_op = 'UPDATE' and not public.has_role((select auth.uid()), 'admin') then
    if new.status is distinct from old.status
      or new.seat_limit is distinct from old.seat_limit
      or new.plan_key is distinct from old.plan_key
      or new.leader_user_id is distinct from old.leader_user_id
      or new.approved_by is distinct from old.approved_by
      or new.approved_at is distinct from old.approved_at then
      raise exception 'COMMUNITY_ADMIN_ONLY_FIELD';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger trading_communities_guard_trg
  before insert or update on public.trading_communities
  for each row execute function public.trading_communities_guard();
create trigger community_memberships_touch before update on public.community_memberships
  for each row execute function public.update_updated_at_column();
create trigger community_invitations_touch before update on public.community_invitations
  for each row execute function public.update_updated_at_column();
create trigger access_entitlements_touch before update on public.access_entitlements
  for each row execute function public.update_updated_at_column();

alter table public.trading_communities enable row level security;
alter table public.community_memberships enable row level security;
alter table public.community_invitations enable row level security;
alter table public.invitation_redemptions enable row level security;
alter table public.access_entitlements enable row level security;
alter table public.community_commission_ledger enable row level security;
alter table public.community_audit_events enable row level security;
alter table public.telegram_link_codes enable row level security;
alter table public.telegram_accounts enable row level security;
alter table public.telegram_broadcast_targets enable row level security;

grant select, insert on public.trading_communities to anon;
grant select, insert, update on public.trading_communities to authenticated;
grant select on public.community_memberships to authenticated;
grant select, insert, update on public.community_invitations to authenticated;
grant select on public.invitation_redemptions to authenticated;
grant select on public.access_entitlements to authenticated;
grant select on public.community_commission_ledger to authenticated;
grant select on public.community_audit_events to authenticated;
grant select, insert, delete on public.telegram_link_codes to authenticated;
grant select, delete on public.telegram_accounts to authenticated;
grant select, delete on public.telegram_broadcast_targets to authenticated;
grant all on public.trading_communities, public.community_memberships,
  public.community_invitations, public.invitation_redemptions,
  public.access_entitlements, public.community_commission_ledger,
  public.community_audit_events, public.telegram_link_codes,
  public.telegram_accounts, public.telegram_broadcast_targets to service_role;

create policy "Anyone applies as pending" on public.trading_communities
  for insert to anon, authenticated with check (char_length(applicant_email) between 3 and 320);
create policy "Admins manage communities" on public.trading_communities
  for all to authenticated using (public.has_role((select auth.uid()), 'admin'))
  with check (public.has_role((select auth.uid()), 'admin'));
create policy "Members read own community" on public.trading_communities
  for select to authenticated using (public.is_community_member(id) or public.is_community_leader(id));
create policy "Leaders update own community profile" on public.trading_communities
  for update to authenticated using (public.is_community_leader(id))
  with check (public.is_community_leader(id));

create policy "Admins manage memberships" on public.community_memberships
  for all to authenticated using (public.has_role((select auth.uid()), 'admin'))
  with check (public.has_role((select auth.uid()), 'admin'));
create policy "Members read relevant memberships" on public.community_memberships
  for select to authenticated using (user_id = (select auth.uid()) or public.is_community_leader(community_id));

create policy "Admins manage invitations" on public.community_invitations
  for all to authenticated using (public.has_role((select auth.uid()), 'admin'))
  with check (public.has_role((select auth.uid()), 'admin'));
create policy "Leaders read invitations" on public.community_invitations
  for select to authenticated using (public.is_community_leader(community_id));
create policy "Leaders create invitations" on public.community_invitations
  for insert to authenticated with check (public.is_community_leader(community_id));
create policy "Leaders revoke invitations" on public.community_invitations
  for update to authenticated using (public.is_community_leader(community_id))
  with check (public.is_community_leader(community_id));

create policy "Redemptions stay private" on public.invitation_redemptions
  for select to authenticated using (
    user_id = (select auth.uid())
    or public.has_role((select auth.uid()), 'admin')
    or public.is_community_leader(community_id)
  );
create policy "Users read own entitlements" on public.access_entitlements
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Admins manage entitlements" on public.access_entitlements
  for all to authenticated using (public.has_role((select auth.uid()), 'admin'))
  with check (public.has_role((select auth.uid()), 'admin'));
create policy "Leaders read commission ledger" on public.community_commission_ledger
  for select to authenticated using (
    public.has_role((select auth.uid()), 'admin') or public.is_community_leader(community_id)
  );
create policy "Leaders read audit events" on public.community_audit_events
  for select to authenticated using (
    public.has_role((select auth.uid()), 'admin') or public.is_community_leader(community_id)
  );
create policy "Admins write audit events" on public.community_audit_events
  for insert to authenticated with check (public.has_role((select auth.uid()), 'admin'));

create policy "Users read own Telegram codes" on public.telegram_link_codes
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Users create own Telegram codes" on public.telegram_link_codes
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Users delete own Telegram codes" on public.telegram_link_codes
  for delete to authenticated using (user_id = (select auth.uid()));
create policy "Users read own Telegram account" on public.telegram_accounts
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Users delete own Telegram account" on public.telegram_accounts
  for delete to authenticated using (user_id = (select auth.uid()));
create policy "Admins read broadcast targets" on public.telegram_broadcast_targets
  for select to authenticated using (public.has_role((select auth.uid()), 'admin'));
create policy "Admins delete broadcast targets" on public.telegram_broadcast_targets
  for delete to authenticated using (public.has_role((select auth.uid()), 'admin'));

create or replace function public.redeem_community_invitation(_token_hash text, _email text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  _uid uuid := auth.uid();
  _inv public.community_invitations%rowtype;
  _community public.trading_communities%rowtype;
  _seats integer;
begin
  if _uid is null then return jsonb_build_object('ok', false, 'reason', 'NOT_AUTHENTICATED'); end if;
  select * into _inv from public.community_invitations where token_hash = _token_hash for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'INVITE_NOT_FOUND'); end if;
  if _inv.revoked_at is not null then return jsonb_build_object('ok', false, 'reason', 'INVITE_REVOKED'); end if;
  if _inv.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'INVITE_EXPIRED'); end if;
  if _inv.email is not null and lower(coalesce(_email, '')) <> lower(_inv.email) then
    return jsonb_build_object('ok', false, 'reason', 'INVITE_EMAIL_MISMATCH');
  end if;
  select * into _community from public.trading_communities where id = _inv.community_id for update;
  if _community.status <> 'approved' then return jsonb_build_object('ok', false, 'reason', 'COMMUNITY_NOT_ACTIVE'); end if;
  if exists (select 1 from public.invitation_redemptions where invitation_id = _inv.id and user_id = _uid) then
    return jsonb_build_object('ok', true, 'reason', 'ALREADY_REDEEMED', 'community_id', _community.id, 'plan_key', _inv.plan_key);
  end if;
  if _inv.uses >= _inv.max_uses then return jsonb_build_object('ok', false, 'reason', 'INVITE_EXHAUSTED'); end if;
  select count(*)::integer into _seats from public.community_memberships
    where community_id = _community.id and status = 'active';
  if _seats >= _community.seat_limit then return jsonb_build_object('ok', false, 'reason', 'SEAT_LIMIT_REACHED'); end if;

  update public.community_invitations set uses = uses + 1, updated_at = now() where id = _inv.id;
  insert into public.invitation_redemptions (invitation_id, user_id, community_id)
    values (_inv.id, _uid, _community.id);
  insert into public.community_memberships (community_id, user_id, role, status)
    values (_community.id, _uid, 'member', 'active')
    on conflict (community_id, user_id) do update set status = 'active', updated_at = now();
  insert into public.access_entitlements (user_id, plan_key, source, community_id, status)
    values (_uid, _inv.plan_key, 'invitation', _community.id, 'active')
    on conflict (user_id, plan_key) do update
      set status = 'active', community_id = excluded.community_id, updated_at = now();
  insert into public.community_audit_events (community_id, actor_user_id, action, detail)
    values (_community.id, _uid, 'invitation.redeemed', jsonb_build_object('invitation_id', _inv.id));
  return jsonb_build_object('ok', true, 'reason', 'REDEEMED', 'community_id', _community.id, 'plan_key', _inv.plan_key);
end;
$$;

revoke all on function public.redeem_community_invitation(text, text) from public;
grant execute on function public.redeem_community_invitation(text, text) to authenticated;

insert into storage.buckets (id, name, public)
values ('broadcast-images', 'broadcast-images', true)
on conflict (id) do update set public = true;

create policy "Public reads broadcast images" on storage.objects
  for select using (bucket_id = 'broadcast-images');
create policy "Admins upload broadcast images" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'broadcast-images' and public.has_role((select auth.uid()), 'admin')
  );
create policy "Admins delete broadcast images" on storage.objects
  for delete to authenticated using (
    bucket_id = 'broadcast-images' and public.has_role((select auth.uid()), 'admin')
  );
