CREATE TABLE public.bot_status_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running','paused')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.bot_status_events TO authenticated;
GRANT ALL ON public.bot_status_events TO service_role;
ALTER TABLE public.bot_status_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own bot status events" ON public.bot_status_events
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert own bot status events" ON public.bot_status_events
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE INDEX bot_status_events_user_created_idx ON public.bot_status_events (user_id, created_at DESC);