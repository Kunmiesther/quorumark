CREATE OR REPLACE FUNCTION public.invoke_paper_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_url text := 'https://project--240a6028-9d5a-4f07-b8e0-d78a3d684a1c-dev.lovable.app/api/public/hooks/paper-tick';
  v_key text := 'sb_publishable_QCSYB0HenKbsXbEXS2rK-Q_JfbaAP4w';
BEGIN
  PERFORM net.http_post(
    url     => v_url,
    headers => jsonb_build_object('content-type', 'application/json', 'apikey', v_key),
    body    => '{}'::jsonb,
    timeout_milliseconds => 20000
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.invoke_paper_tick() FROM public, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'paper-tick-every-minute') THEN
    PERFORM cron.unschedule('paper-tick-every-minute');
  END IF;
END $$;

SELECT cron.schedule(
  'paper-tick-every-minute',
  '* * * * *',
  $cron$select public.invoke_paper_tick();$cron$
);