
-- Trigger functions: never called directly by clients.
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.life_obligations_series_immutable() FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.life_obligations_set_billing_period() FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.life_obligations_write_history() FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.award_points_from_history() FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.order_audit_block_mutation() FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.connection_audit_block_mutation() FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.apex_credential_audit_block_mutation() FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.enforce_max_connections() FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.seed_user_strategy_for_connection() FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, authenticated, anon;

-- Internal RLS/authorization helpers: called from policies (which run as definer)
-- or from other SECURITY DEFINER wrappers, not from client code.
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, app_role) FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.is_execution_halted(uuid, uuid) FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.confirmed_risk_capital(uuid, uuid) FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.is_connection_slot_available(uuid) FROM PUBLIC, authenticated, anon;

-- The `my_*` SECURITY DEFINER wrappers derive the user from auth.uid() and
-- are the intended client entry points; leave EXECUTE for authenticated.
