
GRANT SELECT, INSERT, UPDATE, DELETE ON public.strategy_state TO authenticated;
GRANT ALL ON public.strategy_state TO service_role;

DROP POLICY IF EXISTS "users insert own strategy_state" ON public.strategy_state;
CREATE POLICY "users insert own strategy_state" ON public.strategy_state
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "users update own strategy_state" ON public.strategy_state;
CREATE POLICY "users update own strategy_state" ON public.strategy_state
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "users delete own strategy_state" ON public.strategy_state;
CREATE POLICY "users delete own strategy_state" ON public.strategy_state
  FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE UNIQUE INDEX IF NOT EXISTS strategy_state_user_strategy_key
  ON public.strategy_state (user_id, strategy);
