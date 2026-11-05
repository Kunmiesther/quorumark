ALTER TABLE public.bot_status_events
  ADD COLUMN IF NOT EXISTS trigger_source TEXT NOT NULL DEFAULT 'tap',
  ADD COLUMN IF NOT EXISTS user_agent TEXT;