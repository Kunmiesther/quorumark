
-- Revoke public execute from trigger-only SECURITY DEFINER functions
REVOKE ALL ON FUNCTION public.award_points_from_history() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.life_obligations_write_history() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.seed_user_strategy_for_connection() FROM PUBLIC, anon, authenticated;

-- Revoke anon execute from user-scoped RPC helpers (they require auth.uid())
REVOKE ALL ON FUNCTION public.my_confirmed_risk_capital(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_connection_slot_available() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_execution_halted(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_point_awards(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_points_total() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_risk_capital_summary() FROM PUBLIC, anon;

-- Ensure authenticated retains execute where needed for RPC calls
GRANT EXECUTE ON FUNCTION public.my_confirmed_risk_capital(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_connection_slot_available() TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_execution_halted(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_point_awards(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_points_total() TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_risk_capital_summary() TO authenticated;
