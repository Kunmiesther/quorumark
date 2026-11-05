-- Telegram manual-trade confirmation staging.
--
-- One row per chat holds the LAST analyzed setup awaiting a yes/no reply.
-- Short-lived (expires with the candle), service-role only — the webhook is
-- the only writer/reader; no client policy is needed.

CREATE TABLE public.telegram_pending_trades (
  chat_id BIGINT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry_price NUMERIC NOT NULL,
  stop_level NUMERIC,
  tp_levels JSONB NOT NULL DEFAULT '[]'::jsonb,
  candle_close_ms BIGINT NOT NULL,
  tick_size NUMERIC,
  step_size NUMERIC,
  max_leverage NUMERIC,
  trend_state TEXT,
  onyx_rationale TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT ALL ON public.telegram_pending_trades TO service_role;
ALTER TABLE public.telegram_pending_trades ENABLE ROW LEVEL SECURITY;
