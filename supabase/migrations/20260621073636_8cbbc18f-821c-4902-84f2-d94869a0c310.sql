
DO $$ BEGIN
  CREATE TYPE public.strategy_mode AS ENUM ('long','short');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS active_goal_name TEXT,
  ADD COLUMN IF NOT EXISTS active_goal_target NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS lifetime_harvested_cash NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_leverage_tier INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS strategy_mode public.strategy_mode NOT NULL DEFAULT 'long',
  ADD COLUMN IF NOT EXISTS active_wallet_usd NUMERIC(12,2) NOT NULL DEFAULT 500;
