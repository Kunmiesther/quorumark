
-- 1) Drop symbols that can't do 50x
DELETE FROM public.paper_test_symbols
 WHERE symbol IN ('DOGE-USDT','HOOD-USDT');

-- 2) Standardize leverage on existing 50x+ symbols for all users
UPDATE public.paper_test_symbols SET max_leverage = 100 WHERE symbol IN ('BTC-USDT','ETH-USDT');
UPDATE public.paper_test_symbols
   SET max_leverage = 50
 WHERE symbol IN ('SOL-USDT','XRP-USDT','APEX-USDT','PENGU-USDT','SUI-USDT','AVAX-USDT');

-- 3) Add three new 50x symbols for every user that already has a paper set
INSERT INTO public.paper_test_symbols
  (user_id, symbol, display_name, exchange, enabled, max_leverage, sort_order, market_available)
SELECT u.user_id, v.symbol, split_part(v.symbol,'-',1), 'apex_omni', true, 50, v.sort_order, true
  FROM (SELECT DISTINCT user_id FROM public.paper_test_symbols) u
 CROSS JOIN (VALUES
     ('LINK-USDT', 200),
     ('BNB-USDT',  201),
     ('LTC-USDT',  202)
   ) AS v(symbol, sort_order)
ON CONFLICT (user_id, symbol) DO UPDATE
   SET max_leverage = EXCLUDED.max_leverage,
       enabled = true,
       market_available = true;

-- 4) Wipe trade history and open positions
DELETE FROM public.paper_trades;
DELETE FROM public.paper_positions;

-- 5) Fresh wallets: $600 balance, zeroed counters, cleared cursors, drop any wallets for
--    symbols that no longer exist for the user
DELETE FROM public.paper_wallets w
 WHERE NOT EXISTS (
   SELECT 1 FROM public.paper_test_symbols s
    WHERE s.user_id = w.user_id
      AND s.enabled = true
      AND split_part(s.symbol,'-',1) || '-long'  = w.wallet_key
      OR (s.user_id = w.user_id AND s.enabled = true
          AND split_part(s.symbol,'-',1) || '-short' = w.wallet_key)
 );

UPDATE public.paper_wallets
   SET balance = 600,
       realized_pnl = 0,
       open_position_id = NULL,
       floor_hit = false,
       trades_count = 0,
       wins_count = 0,
       losses_count = 0,
       last_tick_at = NULL,
       last_processed_candle_ts_ms = NULL;

-- 6) Create long+short wallets for any newly-added symbols
INSERT INTO public.paper_wallets (user_id, wallet_key)
SELECT s.user_id, split_part(s.symbol,'-',1) || '-' || d.dir
  FROM public.paper_test_symbols s
  CROSS JOIN (VALUES ('long'),('short')) AS d(dir)
 WHERE s.enabled = true
ON CONFLICT (user_id, wallet_key) DO NOTHING;

-- 7) Update the default symbol seed for future new users
CREATE OR REPLACE FUNCTION public.ensure_paper_wallets(_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_has_any boolean;
  v_defaults text[] := ARRAY[
    'BTC-USDT','ETH-USDT','SOL-USDT','XRP-USDT','APEX-USDT',
    'PENGU-USDT','SUI-USDT','AVAX-USDT','LINK-USDT','BNB-USDT','LTC-USDT'
  ];
  v_lev numeric;
  v_sym text;
  v_idx int := 0;
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.paper_test_symbols WHERE user_id = _user_id) INTO v_has_any;

  IF NOT v_has_any THEN
    FOREACH v_sym IN ARRAY v_defaults LOOP
      v_idx := v_idx + 1;
      v_lev := CASE WHEN v_sym IN ('BTC-USDT','ETH-USDT') THEN 100 ELSE 50 END;
      INSERT INTO public.paper_test_symbols
        (user_id, symbol, display_name, exchange, enabled, max_leverage, sort_order, market_available)
      VALUES
        (_user_id, v_sym, split_part(v_sym, '-', 1), 'apex_omni', true, v_lev, v_idx, true)
      ON CONFLICT (user_id, symbol) DO NOTHING;
    END LOOP;
  END IF;

  INSERT INTO public.paper_wallets (user_id, wallet_key)
  SELECT _user_id, split_part(s.symbol,'-',1) || '-' || d.dir
    FROM public.paper_test_symbols s
    CROSS JOIN (VALUES ('long'),('short')) AS d(dir)
   WHERE s.user_id = _user_id AND s.enabled = true
  ON CONFLICT (user_id, wallet_key) DO NOTHING;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.ensure_paper_wallets(uuid) FROM PUBLIC, anon, authenticated;
