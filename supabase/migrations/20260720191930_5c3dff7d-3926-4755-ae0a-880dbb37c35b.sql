
-- 1. Cross-margin account
CREATE TABLE IF NOT EXISTS public.paper_accounts (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance numeric NOT NULL DEFAULT 3600,
  realized_pnl numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.paper_accounts TO authenticated;
GRANT ALL ON public.paper_accounts TO service_role;

ALTER TABLE public.paper_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own paper account" ON public.paper_accounts;
CREATE POLICY "Users can view their own paper account"
  ON public.paper_accounts FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS trg_paper_accounts_updated_at ON public.paper_accounts;
CREATE TRIGGER trg_paper_accounts_updated_at
  BEFORE UPDATE ON public.paper_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Extend ensure_paper_wallets to also ensure the shared account row.
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
  INSERT INTO public.paper_accounts (user_id, balance, realized_pnl)
  VALUES (_user_id, 3600, 0)
  ON CONFLICT (user_id) DO NOTHING;

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

-- 3. Seed accounts for every existing user
INSERT INTO public.paper_accounts (user_id, balance, realized_pnl)
SELECT id, 3600, 0 FROM auth.users
ON CONFLICT (user_id) DO UPDATE
  SET balance = 3600, realized_pnl = 0, updated_at = now();

-- 4. Clean cross restart: wipe positions/trades, reset wallet aggregates.
DELETE FROM public.paper_trades;
DELETE FROM public.paper_positions;

UPDATE public.paper_wallets SET
  balance = 0,
  realized_pnl = 0,
  open_position_id = NULL,
  trades_count = 0,
  wins_count = 0,
  losses_count = 0,
  floor_hit = false,
  last_processed_candle_ts_ms = NULL,
  last_tick_at = NULL;
