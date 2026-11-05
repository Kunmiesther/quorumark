
CREATE TABLE IF NOT EXISTS public.user_strategy_toggles (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, strategy)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_strategy_toggles TO authenticated;
GRANT ALL ON public.user_strategy_toggles TO service_role;

ALTER TABLE public.user_strategy_toggles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users read own strategy toggles" ON public.user_strategy_toggles;
CREATE POLICY "users read own strategy toggles" ON public.user_strategy_toggles
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "users insert own strategy toggles" ON public.user_strategy_toggles;
CREATE POLICY "users insert own strategy toggles" ON public.user_strategy_toggles
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "users update own strategy toggles" ON public.user_strategy_toggles;
CREATE POLICY "users update own strategy toggles" ON public.user_strategy_toggles
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "users delete own strategy toggles" ON public.user_strategy_toggles;
CREATE POLICY "users delete own strategy toggles" ON public.user_strategy_toggles
  FOR DELETE TO authenticated USING (user_id = auth.uid());
