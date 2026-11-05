GRANT SELECT ON public.worker_heartbeats TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'worker_heartbeats'
      AND policyname = 'Authenticated can view worker heartbeats'
  ) THEN
    CREATE POLICY "Authenticated can view worker heartbeats"
      ON public.worker_heartbeats
      FOR SELECT
      TO authenticated
      USING (true);
  END IF;
END $$;