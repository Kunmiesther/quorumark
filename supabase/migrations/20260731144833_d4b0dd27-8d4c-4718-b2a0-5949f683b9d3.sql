-- 1. Per-symbol strategy identity
ALTER TABLE public.user_strategy
  ADD COLUMN IF NOT EXISTS symbol text NOT NULL DEFAULT 'BTC-USDT';

ALTER TABLE public.user_strategy DROP CONSTRAINT user_strategy_pkey;
ALTER TABLE public.user_strategy
  ADD CONSTRAINT user_strategy_pkey PRIMARY KEY (user_id, connection_id, symbol);

-- 2. Seed trigger must target the new key
CREATE OR REPLACE FUNCTION public.seed_user_strategy_for_connection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  default_strategy_id uuid;
BEGIN
  SELECT id INTO default_strategy_id FROM public.strategies WHERE slug = 'dca' LIMIT 1;
  IF default_strategy_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.user_strategy
    (user_id, connection_id, symbol, strategy_id, market_type, cross_margin, enabled, mode, params, hedge_guard, margin_mode)
  VALUES
    (NEW.user_id, NEW.id, 'BTC-USDT', default_strategy_id, 'spot', true, false, 'paper', '{}'::jsonb, '{}'::jsonb, 'cross')
  ON CONFLICT (user_id, connection_id, symbol) DO NOTHING;

  RETURN NEW;
END; $function$;

-- 3. View resolves symbol from params first, then the column
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
     JOIN exchange_connections ec ON ec.id = us.connection_id AND ec.user_id = us.user_id
     CROSS JOIN LATERAL ( SELECT pts.symbol
           FROM paper_test_symbols pts
          WHERE us.mode = 'paper'::text AND pts.user_id = us.user_id AND pts.enabled = true AND COALESCE(pts.market_available, true) = true
        UNION ALL
         SELECT COALESCE(us.params ->> 'symbol'::text, us.symbol, 'BTC-USDT'::text) AS "coalesce"
          WHERE us.mode IS DISTINCT FROM 'paper'::text) sym;