REVOKE ALL ON FUNCTION public.strategy_decisions_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.strategy_decisions_guard() FROM anon;
REVOKE ALL ON FUNCTION public.strategy_decisions_guard() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.strategy_decisions_guard() TO service_role;