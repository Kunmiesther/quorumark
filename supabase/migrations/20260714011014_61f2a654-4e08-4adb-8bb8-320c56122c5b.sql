
-- FIX 1: bot_heartbeat - restrict SELECT to authenticated
DROP POLICY IF EXISTS "Anyone can read bot status" ON public.bot_heartbeat;
CREATE POLICY "Authenticated can read bot status"
  ON public.bot_heartbeat
  FOR SELECT
  TO authenticated
  USING (true);
REVOKE SELECT ON public.bot_heartbeat FROM anon;
GRANT SELECT ON public.bot_heartbeat TO authenticated;

-- FIX 2: avatars SELECT policy tightened to owner folder
DROP POLICY IF EXISTS "Avatars readable by authenticated" ON storage.objects;
CREATE POLICY "Users read own avatar"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (auth.uid())::text = (storage.foldername(name))[1]
  );
