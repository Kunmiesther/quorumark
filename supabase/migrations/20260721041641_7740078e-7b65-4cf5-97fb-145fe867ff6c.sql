
-- Drop Fusion runtime/trading tables (Fusion is now a custom product, not a bot)
DROP TABLE IF EXISTS public.fusion_recommendations CASCADE;
DROP TABLE IF EXISTS public.fusion_sleeves CASCADE;
DROP TABLE IF EXISTS public.fusion_formation_events CASCADE;

-- Remove any previously persisted user toggle rows for the retired 'fusion' key
DELETE FROM public.user_strategy_toggles WHERE strategy = 'fusion';

-- Qualification/lead requests for the custom Fusion + Scout product surface.
-- No entitlements, no execution — this is a durable lead record only.
CREATE TABLE public.fusion_lead_requests (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  company TEXT,
  target_venues TEXT,
  symbols TEXT,
  timeframes TEXT,
  delivery_needs TEXT,
  risk_limits TEXT,
  automation_level TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'submitted',
  submission_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fusion_lead_requests_email_ck CHECK (contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT fusion_lead_requests_name_len CHECK (char_length(contact_name) BETWEEN 1 AND 200),
  CONSTRAINT fusion_lead_requests_status_ck CHECK (status IN ('submitted','contacted','qualified','archived')),
  CONSTRAINT fusion_lead_requests_idem UNIQUE (user_id, submission_hash)
);

CREATE INDEX fusion_lead_requests_user_created_idx
  ON public.fusion_lead_requests (user_id, created_at DESC);

GRANT SELECT, INSERT ON public.fusion_lead_requests TO authenticated;
GRANT ALL ON public.fusion_lead_requests TO service_role;

ALTER TABLE public.fusion_lead_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fusion_leads_select_own"
  ON public.fusion_lead_requests FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "fusion_leads_insert_own"
  ON public.fusion_lead_requests FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id AND status = 'submitted');

-- Simple rate limit trigger: max 5 submissions per user per hour
CREATE OR REPLACE FUNCTION public.fusion_lead_rate_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  recent_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO recent_count
  FROM public.fusion_lead_requests
  WHERE user_id = NEW.user_id
    AND created_at > now() - INTERVAL '1 hour';
  IF recent_count >= 5 THEN
    RAISE EXCEPTION 'rate_limited: too many Fusion requests in the last hour';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fusion_lead_rate_limit_trg
  BEFORE INSERT ON public.fusion_lead_requests
  FOR EACH ROW EXECUTE FUNCTION public.fusion_lead_rate_limit();
