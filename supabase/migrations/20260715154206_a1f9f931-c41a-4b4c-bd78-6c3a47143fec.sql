
CREATE TABLE public.user_trading_limits (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  max_order_size_usd NUMERIC(18,2) NOT NULL DEFAULT 25 CHECK (max_order_size_usd >= 0),
  max_total_exposure_usd NUMERIC(18,2) NOT NULL DEFAULT 100 CHECK (max_total_exposure_usd >= 0),
  daily_loss_limit_usd NUMERIC(18,2) NOT NULL DEFAULT 25 CHECK (daily_loss_limit_usd >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_trading_limits TO authenticated;
GRANT ALL ON public.user_trading_limits TO service_role;

ALTER TABLE public.user_trading_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own_limits_select" ON public.user_trading_limits
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own_limits_insert" ON public.user_trading_limits
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own_limits_update" ON public.user_trading_limits
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own_limits_delete" ON public.user_trading_limits
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER user_trading_limits_updated_at
  BEFORE UPDATE ON public.user_trading_limits
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
