
CREATE TABLE IF NOT EXISTS public.collectible_notify_prefs (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  notify BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.collectible_notify_prefs TO authenticated;
GRANT ALL ON public.collectible_notify_prefs TO service_role;

ALTER TABLE public.collectible_notify_prefs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own_collectible_notify_select" ON public.collectible_notify_prefs
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own_collectible_notify_insert" ON public.collectible_notify_prefs
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own_collectible_notify_update" ON public.collectible_notify_prefs
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own_collectible_notify_delete" ON public.collectible_notify_prefs
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.collectible_notify_touch() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS collectible_notify_touch_trg ON public.collectible_notify_prefs;
CREATE TRIGGER collectible_notify_touch_trg BEFORE UPDATE ON public.collectible_notify_prefs
  FOR EACH ROW EXECUTE FUNCTION public.collectible_notify_touch();
