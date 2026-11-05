
-- ============================================================
-- paper_wallets
-- ============================================================
CREATE TABLE public.paper_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wallet_key text NOT NULL,
  balance numeric NOT NULL DEFAULT 600,
  realized_pnl numeric NOT NULL DEFAULT 0,
  open_position_id uuid,
  floor_hit boolean NOT NULL DEFAULT false,
  trades_count integer NOT NULL DEFAULT 0,
  wins_count integer NOT NULL DEFAULT 0,
  losses_count integer NOT NULL DEFAULT 0,
  last_tick_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, wallet_key),
  CONSTRAINT paper_wallets_key_check CHECK (
    wallet_key IN ('BTC-long','BTC-short','ETH-long','ETH-short','SOL-long','SOL-short')
  )
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.paper_wallets TO authenticated;
GRANT ALL ON public.paper_wallets TO service_role;
ALTER TABLE public.paper_wallets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own paper wallets" ON public.paper_wallets
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER paper_wallets_touch
  BEFORE UPDATE ON public.paper_wallets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- paper_positions
-- ============================================================
CREATE TABLE public.paper_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wallet_key text NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('long','short')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  entry_price numeric NOT NULL,
  entry_ts timestamptz NOT NULL,
  entry_candle_ts_ms bigint NOT NULL,
  tp_level numeric,
  stop_level numeric NOT NULL,
  zone_lower numeric NOT NULL,
  zone_upper numeric NOT NULL,
  zone_level numeric NOT NULL,
  size_qty numeric NOT NULL,
  size_notional numeric NOT NULL,
  margin numeric NOT NULL,
  leverage numeric NOT NULL,
  entry_fee numeric NOT NULL DEFAULT 0,
  opened_from_signal text,
  last_seen_candle_ts_ms bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.paper_positions TO authenticated;
GRANT ALL ON public.paper_positions TO service_role;
ALTER TABLE public.paper_positions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own paper positions" ON public.paper_positions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER paper_positions_touch
  BEFORE UPDATE ON public.paper_positions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX paper_positions_user_status_idx
  ON public.paper_positions(user_id, status);

-- ============================================================
-- paper_trades (closed simulated round-trips)
-- ============================================================
CREATE TABLE public.paper_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wallet_key text NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('long','short')),
  entry_price numeric NOT NULL,
  exit_price numeric NOT NULL,
  exit_reason text NOT NULL CHECK (exit_reason IN ('tp_touch','stop','floor')),
  size_qty numeric NOT NULL,
  size_notional numeric NOT NULL,
  margin numeric NOT NULL,
  leverage numeric NOT NULL,
  pnl_gross numeric NOT NULL,
  fees numeric NOT NULL,
  slippage_cost numeric NOT NULL,
  pnl_net numeric NOT NULL,
  hold_seconds integer NOT NULL,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz NOT NULL,
  position_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.paper_trades TO authenticated;
GRANT ALL ON public.paper_trades TO service_role;
ALTER TABLE public.paper_trades ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own paper trades" ON public.paper_trades
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX paper_trades_user_closed_idx
  ON public.paper_trades(user_id, closed_at DESC);

-- ============================================================
-- Seed helper: create the 6 wallets for a user
-- ============================================================
CREATE OR REPLACE FUNCTION public.ensure_paper_wallets(_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.paper_wallets (user_id, wallet_key)
  VALUES
    (_user_id, 'BTC-long'),
    (_user_id, 'BTC-short'),
    (_user_id, 'ETH-long'),
    (_user_id, 'ETH-short'),
    (_user_id, 'SOL-long'),
    (_user_id, 'SOL-short')
  ON CONFLICT (user_id, wallet_key) DO NOTHING;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_paper_wallets(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_paper_wallets(uuid) TO service_role;

-- ============================================================
-- Extend handle_new_user to seed paper wallets
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.subscriptions (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user')
  ON CONFLICT (user_id, role) DO NOTHING;

  INSERT INTO public.life_categories (user_id, key, label, icon, is_custom, is_essential, sort_order) VALUES
    (NEW.id, 'roof',     'Roof',     'home',        false, true,  1),
    (NEW.id, 'ride',     'Ride',     'car',         false, true,  2),
    (NEW.id, 'memories', 'Memories', 'camera',      false, false, 3),
    (NEW.id, 'escape',   'Escape',   'plane',       false, false, 4),
    (NEW.id, 'body',     'Body',     'heart',       false, true,  5),
    (NEW.id, 'family',   'Family',   'users',       false, false, 6),
    (NEW.id, 'debt',     'Debt',     'credit-card', false, true,  7),
    (NEW.id, 'future',   'Future',   'sparkles',    false, false, 8)
  ON CONFLICT (user_id, key) DO NOTHING;

  PERFORM public.ensure_paper_wallets(NEW.id);

  RETURN NEW;
END;
$$;
