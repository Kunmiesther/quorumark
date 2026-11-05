-- Extend subscription_tier enum: free, pro, elite -> free, ion, arc, orb, zen
-- Strategy: rename old enum, create new enum with all 5 values, migrate the
-- subscriptions.tier column (mapping pro->orb, elite->zen), drop the old enum.

ALTER TYPE public.subscription_tier RENAME TO subscription_tier_old;

CREATE TYPE public.subscription_tier AS ENUM ('free', 'ion', 'arc', 'orb', 'zen');

ALTER TABLE public.subscriptions
  ALTER COLUMN tier DROP DEFAULT;

ALTER TABLE public.subscriptions
  ALTER COLUMN tier TYPE public.subscription_tier
  USING (
    CASE tier::text
      WHEN 'pro' THEN 'orb'
      WHEN 'elite' THEN 'zen'
      WHEN 'free' THEN 'free'
      ELSE 'free'
    END
  )::public.subscription_tier;

ALTER TABLE public.subscriptions
  ALTER COLUMN tier SET DEFAULT 'free'::public.subscription_tier;

DROP TYPE public.subscription_tier_old;