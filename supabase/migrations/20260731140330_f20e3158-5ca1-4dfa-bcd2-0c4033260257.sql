CREATE OR REPLACE VIEW public.active_bot_config AS
 SELECT us.user_id,
    ec.exchange AS exchange_type,
    sym.symbol,
    us.market_type::text AS market_type,
    us.cross_margin,
    us.params,
    us.enabled,
    us.mode,
    ec.id AS connection_id,
    ec.permission_trade,
    ec.permissions_verified,
    ec.environment,
    ec.status::text AS status
   FROM user_strategy us
     JOIN profiles p ON p.id = us.user_id
     JOIN exchange_connections ec
       ON ec.id = us.connection_id
      AND ec.user_id = us.user_id
     CROSS JOIN LATERAL ( SELECT pts.symbol
           FROM paper_test_symbols pts
          WHERE us.mode = 'paper'::text AND pts.user_id = us.user_id AND pts.enabled = true AND COALESCE(pts.market_available, true) = true
        UNION ALL
         SELECT COALESCE(us.params ->> 'symbol'::text, 'BTC-USDT'::text) AS "coalesce"
          WHERE us.mode IS DISTINCT FROM 'paper'::text) sym;