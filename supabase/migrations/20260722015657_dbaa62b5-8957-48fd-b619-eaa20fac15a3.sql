
CREATE TABLE public.waitlist_signups (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('presale','nft_genesis','nft_evolution','merch','community','general')),
  email TEXT NOT NULL,
  source TEXT,
  notes TEXT,
  consent BOOLEAN NOT NULL DEFAULT FALSE,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX waitlist_signups_kind_email_key
  ON public.waitlist_signups (kind, lower(email));

GRANT INSERT ON public.waitlist_signups TO anon;
GRANT INSERT ON public.waitlist_signups TO authenticated;
GRANT ALL ON public.waitlist_signups TO service_role;

ALTER TABLE public.waitlist_signups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can submit a waitlist entry"
  ON public.waitlist_signups
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (consent = TRUE AND char_length(email) BETWEEN 3 AND 320);

CREATE POLICY "Admins can view waitlist entries"
  ON public.waitlist_signups
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can manage waitlist entries"
  ON public.waitlist_signups
  FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
