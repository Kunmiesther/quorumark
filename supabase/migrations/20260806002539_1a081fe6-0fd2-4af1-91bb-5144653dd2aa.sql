-- 1) search_path hardening on the two remaining mutable-path guard functions
ALTER FUNCTION public.commission_ledger_append_only() SET search_path = public;
ALTER FUNCTION public.paper_engine_ops_block_zombie_reclaim() SET search_path = public;

-- 2) Revoke anon/PUBLIC EXECUTE on SECURITY DEFINER functions.
--    None of these are used by any anon-role RLS policy or unauthenticated path.
REVOKE EXECUTE ON FUNCTION public.agentic_gate_owner_only() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.commission_rules_guard() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.community_seats_used(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enforce_owner_only_live() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enforce_owner_only_order_intent() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.exchange_connection_exists(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_community_leader(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_community_member(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.my_ensure_paper_ready() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.owns_exchange_connection(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.paper_positions_bind_orchestration() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.paper_positions_require_orchestration() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.paper_trades_bind_orchestration() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.paper_trades_inherit_orchestration() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.profiles_paper_ready_on_onboarding() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.redeem_community_invitation(text, text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.trading_communities_guard() FROM anon, PUBLIC;

-- Preserve the intended callers.
GRANT EXECUTE ON FUNCTION public.community_seats_used(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.exchange_connection_exists(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_community_leader(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_community_member(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.my_ensure_paper_ready() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.owns_exchange_connection(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.redeem_community_invitation(text, text) TO authenticated, service_role;

-- 3) user_strategy: require real, owned connection ownership (connection_id is NOT NULL).
DROP POLICY IF EXISTS "Users manage own strategy" ON public.user_strategy;
CREATE POLICY "Users manage own strategy"
ON public.user_strategy
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id AND public.owns_exchange_connection(connection_id));