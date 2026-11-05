-- The production restore opted into explicit Data API privileges. Restore the
-- minimum read grants used by the canonical access resolver; RLS still limits
-- every signed-in user to the rows their policies allow.
grant select on public.user_roles to authenticated;
grant select on public.access_entitlements to authenticated;
grant select on public.community_memberships to authenticated;
grant select on public.trading_communities to authenticated;

-- Role checks are called by authenticated UI/server flows. SECURITY INVOKER
-- keeps the lookup subject to user_roles RLS, so a caller can only inspect
-- their own roles. The service role retains its existing trusted access.
alter function public.has_role(uuid, public.app_role) security invoker;
grant execute on function public.has_role(uuid, public.app_role) to authenticated;
