GRANT SELECT, INSERT ON public.bot_events TO authenticated;
GRANT ALL ON public.bot_events TO service_role;
CREATE POLICY "users insert own bot_events" ON public.bot_events
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());