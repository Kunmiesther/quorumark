-- Telegram bot linking.
--
-- Two tables:
--   telegram_link_codes  — short-lived, single-use codes minted from the
--                           dashboard by an authenticated user and redeemed
--                           by the Telegram webhook (service role only).
--   telegram_accounts    — durable chat_id -> user_id mapping once linked.
--
-- Neither table is ever read by the signer, broker, or any order path.

CREATE TABLE public.telegram_link_codes (
  code TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, DELETE ON public.telegram_link_codes TO authenticated;
GRANT ALL ON public.telegram_link_codes TO service_role;
ALTER TABLE public.telegram_link_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own link codes" ON public.telegram_link_codes
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users insert own link codes" ON public.telegram_link_codes
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own link codes" ON public.telegram_link_codes
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.telegram_accounts (
  chat_id BIGINT PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  telegram_username TEXT,
  telegram_first_name TEXT,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, DELETE ON public.telegram_accounts TO authenticated;
GRANT ALL ON public.telegram_accounts TO service_role;
ALTER TABLE public.telegram_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view own telegram link" ON public.telegram_accounts
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
-- Disconnect from the dashboard. Linking itself only ever happens via the
-- webhook's service-role client, which redeems a code minted by the owner.
CREATE POLICY "Users delete own telegram link" ON public.telegram_accounts
  FOR DELETE TO authenticated USING (auth.uid() = user_id);
