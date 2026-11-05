-- Supabase grants function execution to PUBLIC by default. Remove that grant
-- explicitly from anon and prevent direct calls to trigger-only functions.
revoke all on function public.is_community_leader(uuid) from public, anon;
revoke all on function public.is_community_member(uuid) from public, anon;
revoke all on function public.join_community_competition(uuid, text, text) from public, anon;
revoke all on function public.redeem_community_invitation(text, text) from public, anon;
revoke all on function public.trading_communities_guard() from public, anon, authenticated;
revoke all on function public.competition_scores_append_only() from public, anon, authenticated;

grant execute on function public.is_community_leader(uuid) to authenticated, service_role;
grant execute on function public.is_community_member(uuid) to authenticated, service_role;
grant execute on function public.join_community_competition(uuid, text, text) to authenticated;
grant execute on function public.redeem_community_invitation(text, text) to authenticated;

create index if not exists trading_communities_leader_idx
  on public.trading_communities (leader_user_id) where leader_user_id is not null;
create index if not exists trading_communities_approved_by_idx
  on public.trading_communities (approved_by) where approved_by is not null;
create index if not exists community_invitations_created_by_idx
  on public.community_invitations (created_by) where created_by is not null;
create index if not exists invitation_redemptions_user_idx
  on public.invitation_redemptions (user_id, community_id);
create index if not exists invitation_redemptions_community_idx
  on public.invitation_redemptions (community_id);
create index if not exists access_entitlements_community_idx
  on public.access_entitlements (community_id) where community_id is not null;
create index if not exists community_commission_ledger_community_idx
  on public.community_commission_ledger (community_id, period_start desc);
create index if not exists community_audit_events_actor_idx
  on public.community_audit_events (actor_user_id) where actor_user_id is not null;
create index if not exists telegram_broadcast_targets_registered_by_idx
  on public.telegram_broadcast_targets (registered_by) where registered_by is not null;
create index if not exists community_competitions_created_by_idx
  on public.community_competitions (created_by);
create index if not exists community_competition_scores_user_idx
  on public.community_competition_score_snapshots (user_id, competition_id, created_at desc);
create index if not exists community_competition_campaigns_scope_idx
  on public.community_competition_campaigns (competition_id, community_id);
create index if not exists community_competition_campaigns_created_by_idx
  on public.community_competition_campaigns (created_by);
