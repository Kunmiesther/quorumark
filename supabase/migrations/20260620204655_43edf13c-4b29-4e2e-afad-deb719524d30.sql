
-- ===== ENUMS =====
CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');
CREATE TYPE public.account_mode AS ENUM ('spot', 'futures');
CREATE TYPE public.bot_status AS ENUM ('running', 'paused');
CREATE TYPE public.market_support AS ENUM ('spot', 'futures', 'both');
CREATE TYPE public.risk_level AS ENUM ('low', 'medium', 'high');
CREATE TYPE public.position_side AS ENUM ('long', 'short');
CREATE TYPE public.position_status AS ENUM ('open', 'closed');
CREATE TYPE public.connection_status AS ENUM ('connected', 'error', 'disconnected');
CREATE TYPE public.subscription_tier AS ENUM ('free', 'pro', 'elite');

-- ===== UPDATE TIMESTAMP HELPER =====
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- ===== STRATEGIES (catalog) =====
CREATE TABLE public.strategies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  suit_name TEXT NOT NULL,
  suit_design TEXT NOT NULL,
  markets public.market_support NOT NULL,
  risk public.risk_level NOT NULL,
  trait TEXT NOT NULL,
  ring_color TEXT NOT NULL,
  suit_image TEXT NOT NULL,
  description TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.strategies TO anon, authenticated;
GRANT ALL ON public.strategies TO service_role;
ALTER TABLE public.strategies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Strategies are publicly readable" ON public.strategies FOR SELECT USING (true);

-- ===== PROFILES =====
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  demo_mode BOOLEAN NOT NULL DEFAULT true,
  account_mode public.account_mode NOT NULL DEFAULT 'spot',
  bot_status public.bot_status NOT NULL DEFAULT 'paused',
  risk_acknowledged BOOLEAN NOT NULL DEFAULT false,
  risk_acknowledged_at TIMESTAMPTZ,
  onboarding_complete BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own profile" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "Users insert own profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY "Users update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ===== USER ROLES =====
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own roles" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

-- ===== USER STRATEGY =====
CREATE TABLE public.user_strategy (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  strategy_id UUID NOT NULL REFERENCES public.strategies(id),
  market_type public.account_mode NOT NULL DEFAULT 'spot',
  cross_margin BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_strategy TO authenticated;
GRANT ALL ON public.user_strategy TO service_role;
ALTER TABLE public.user_strategy ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own strategy" ON public.user_strategy FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER user_strategy_updated_at BEFORE UPDATE ON public.user_strategy FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ===== EXCHANGE CONNECTIONS =====
CREATE TABLE public.exchange_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  api_secret_encrypted TEXT NOT NULL,
  withdrawals_disabled BOOLEAN NOT NULL DEFAULT true,
  permission_trade BOOLEAN NOT NULL DEFAULT true,
  permission_read BOOLEAN NOT NULL DEFAULT true,
  status public.connection_status NOT NULL DEFAULT 'disconnected',
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.exchange_connections TO authenticated;
GRANT ALL ON public.exchange_connections TO service_role;
ALTER TABLE public.exchange_connections ENABLE ROW LEVEL SECURITY;
-- IMPORTANT: secrets must never go to client; we still need owner SELECT, but server code should project safe columns only.
CREATE POLICY "Users view own connections" ON public.exchange_connections FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users insert own connections" ON public.exchange_connections FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id AND withdrawals_disabled = true);
CREATE POLICY "Users update own connections" ON public.exchange_connections FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (withdrawals_disabled = true);
CREATE POLICY "Users delete own connections" ON public.exchange_connections FOR DELETE TO authenticated USING (auth.uid() = user_id);
CREATE TRIGGER exchange_connections_updated_at BEFORE UPDATE ON public.exchange_connections FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ===== POSITIONS =====
CREATE TABLE public.positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange TEXT NOT NULL,
  market_type public.account_mode NOT NULL,
  pair TEXT NOT NULL,
  side public.position_side NOT NULL,
  entry_price NUMERIC(20,8) NOT NULL,
  current_price NUMERIC(20,8) NOT NULL,
  size NUMERIC(20,8) NOT NULL DEFAULT 0,
  leverage NUMERIC(6,2),
  pnl_amount NUMERIC(20,8) NOT NULL DEFAULT 0,
  pnl_pct NUMERIC(10,4) NOT NULL DEFAULT 0,
  status public.position_status NOT NULL DEFAULT 'open',
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.positions TO authenticated;
GRANT ALL ON public.positions TO service_role;
ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own positions" ON public.positions FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users manage own positions" ON public.positions FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER positions_updated_at BEFORE UPDATE ON public.positions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ===== TRADES (closed history) =====
CREATE TABLE public.trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  strategy_id UUID REFERENCES public.strategies(id),
  exchange TEXT NOT NULL,
  market_type public.account_mode NOT NULL,
  pair TEXT NOT NULL,
  side public.position_side NOT NULL,
  entry_price NUMERIC(20,8) NOT NULL,
  exit_price NUMERIC(20,8) NOT NULL,
  size NUMERIC(20,8) NOT NULL,
  leverage NUMERIC(6,2),
  realized_pnl NUMERIC(20,8) NOT NULL,
  realized_pnl_pct NUMERIC(10,4) NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trades TO authenticated;
GRANT ALL ON public.trades TO service_role;
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own trades" ON public.trades FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users manage own trades" ON public.trades FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ===== SUBSCRIPTIONS (placeholder) =====
CREATE TABLE public.subscriptions (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tier public.subscription_tier NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'inactive',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subscriptions TO authenticated;
GRANT ALL ON public.subscriptions TO service_role;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own subscription" ON public.subscriptions FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE TRIGGER subscriptions_updated_at BEFORE UPDATE ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ===== SIGNUP HANDLER: profile + default strategy + free subscription + user role =====
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  default_strategy_id UUID;
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)));

  INSERT INTO public.subscriptions (user_id) VALUES (NEW.id);
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'user');

  SELECT id INTO default_strategy_id FROM public.strategies WHERE slug = 'dca' LIMIT 1;
  IF default_strategy_id IS NOT NULL THEN
    INSERT INTO public.user_strategy (user_id, strategy_id) VALUES (NEW.id, default_strategy_id);
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
