
-- 1. paper_test_symbols table
CREATE TABLE public.paper_test_symbols (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  display_name text NOT NULL,
  exchange text NOT NULL DEFAULT 'apex_omni',
  enabled boolean NOT NULL DEFAULT true,
  max_leverage numeric NOT NULL DEFAULT 25,
  tick_size numeric,
  step_size numeric,
  min_order_size numeric,
  market_available boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  notes text,
  added_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.paper_test_symbols TO authenticated;
GRANT ALL ON public.paper_test_symbols TO service_role;

ALTER TABLE public.paper_test_symbols ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own paper test symbols"
  ON public.paper_test_symbols
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER paper_test_symbols_touch
  BEFORE UPDATE ON public.paper_test_symbols
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX paper_test_symbols_user_enabled_idx
  ON public.paper_test_symbols (user_id, enabled);

-- 2. Drop the fixed wallet_key CHECK constraint so any symbol/direction combo is allowed.
ALTER TABLE public.paper_wallets DROP CONSTRAINT IF EXISTS paper_wallets_key_check;

-- 3. Replace ensure_paper_wallets: seed defaults, then wallets per enabled symbol.
CREATE OR REPLACE FUNCTION public.ensure_paper_wallets(_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_has_any boolean;
  v_defaults text[] := ARRAY[
    'BTC-USDT','ETH-USDT','SOL-USDT','XRP-USDT','APEX-USDT',
    'PENGU-USDT','HOOD-USDT','DOGE-USDT','SUI-USDT','AVAX-USDT'
  ];
  v_sym text;
  v_idx int := 0;
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.paper_test_symbols WHERE user_id = _user_id) INTO v_has_any;

  IF NOT v_has_any THEN
    FOREACH v_sym IN ARRAY v_defaults LOOP
      v_idx := v_idx + 1;
      INSERT INTO public.paper_test_symbols
        (user_id, symbol, display_name, exchange, enabled, max_leverage, sort_order, market_available)
      VALUES
        (_user_id, v_sym, split_part(v_sym, '-', 1), 'apex_omni', true, 25, v_idx, true)
      ON CONFLICT (user_id, symbol) DO NOTHING;
    END LOOP;
  END IF;

  -- Create a long + short wallet for every ENABLED symbol row.
  INSERT INTO public.paper_wallets (user_id, wallet_key)
  SELECT _user_id, split_part(s.symbol,'-',1) || '-' || d.dir
    FROM public.paper_test_symbols s
    CROSS JOIN (VALUES ('long'),('short')) AS d(dir)
   WHERE s.user_id = _user_id AND s.enabled = true
  ON CONFLICT (user_id, wallet_key) DO NOTHING;
END;
$function$;
