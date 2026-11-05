DROP POLICY IF EXISTS "Users view own bot status events" ON public.bot_status_events;
CREATE POLICY "Users view own bot status events"
  ON public.bot_status_events
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own bot status events"
  ON public.bot_status_events
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);