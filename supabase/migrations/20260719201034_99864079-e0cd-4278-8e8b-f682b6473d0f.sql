CREATE OR REPLACE VIEW public.active_bot_config AS
SELECT
  us.user_id,
  ec.exchange       AS exchange_type,
  sym.symbol        AS symbol,
  us.market_type::text AS market_type,
  us.cross_margin,
  us.params,
  us.enabled,
  us.mode,
  ec.id             AS connection_id,
  ec.permission_trade,
  ec.permissions_verified,
  ec.environment,
  ec.status::text   AS status
FROM public.user_strategy us
JOIN public.profiles p ON p.id = us.user_id
LEFT JOIN public.exchange_connections ec ON ec.user_id = us.user_id
CROSS JOIN LATERAL (
  -- Paper mode: fan out to every enabled + venue-available paper test symbol
  SELECT pts.symbol
    FROM public.paper_test_symbols pts
   WHERE us.mode = 'paper'
     AND pts.user_id = us.user_id
     AND pts.enabled = true
     AND COALESCE(pts.market_available, true) = true
  UNION ALL
  -- Non-paper modes: preserve the legacy single-symbol behavior
  SELECT COALESCE(us.params->>'symbol', 'BTC-USDT')
   WHERE us.mode IS DISTINCT FROM 'paper'
) sym;

REVOKE ALL ON public.active_bot_config FROM PUBLIC;
REVOKE ALL ON public.active_bot_config FROM authenticated, anon;
GRANT SELECT ON public.active_bot_config TO service_role;