
CREATE TABLE public.bot_heartbeat (
  id INTEGER PRIMARY KEY DEFAULT 1,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  mode TEXT NOT NULL DEFAULT 'demo',
  credentials_ok BOOLEAN NOT NULL DEFAULT false,
  message TEXT,
  CONSTRAINT bot_heartbeat_singleton CHECK (id = 1)
);

GRANT SELECT ON public.bot_heartbeat TO authenticated, anon;
GRANT ALL ON public.bot_heartbeat TO service_role;

ALTER TABLE public.bot_heartbeat ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read bot status"
  ON public.bot_heartbeat FOR SELECT
  USING (true);

INSERT INTO public.bot_heartbeat (id, mode, credentials_ok, message)
VALUES (1, 'demo', false, 'Worker has not reported in yet')
ON CONFLICT (id) DO NOTHING;
