-- Community broadcast targets — group/channel chats the bot posts
-- announcements into, separate from individual telegram_accounts DMs.
-- Registered via the bot itself (/register inside the group, by an
-- admin-linked account), not the dashboard, since only Telegram tells us
-- the chat_id once the bot is actually a member.

CREATE TABLE public.telegram_broadcast_targets (
  chat_id BIGINT PRIMARY KEY,
  title TEXT,
  chat_type TEXT NOT NULL,
  registered_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, DELETE ON public.telegram_broadcast_targets TO authenticated;
GRANT ALL ON public.telegram_broadcast_targets TO service_role;
ALTER TABLE public.telegram_broadcast_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins view broadcast targets" ON public.telegram_broadcast_targets
  FOR SELECT TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins remove broadcast targets" ON public.telegram_broadcast_targets
  FOR DELETE TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));
