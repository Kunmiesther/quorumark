
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS onboarding_complete_v2 boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pin_hash text,
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS face_id_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notifications_enabled boolean NOT NULL DEFAULT false;

-- Existing users who completed legacy onboarding skip the new flow
UPDATE public.profiles SET onboarding_complete_v2 = true WHERE onboarding_complete = true;
