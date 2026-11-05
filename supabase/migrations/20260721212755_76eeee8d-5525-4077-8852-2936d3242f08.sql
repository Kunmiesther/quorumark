
-- Re-arm paper-tick-every-minute cron after C4 sole-authority patch verified.
-- Idempotent: unschedules any existing job of the same name first.
DO $$
BEGIN
  PERFORM cron.unschedule('paper-tick-every-minute');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'paper-tick-every-minute',
  '* * * * *',
  $cron$SELECT public.invoke_paper_tick();$cron$
);
