CREATE OR REPLACE FUNCTION public.invoke_paper_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_url text := 'https://turtle-trade-guard.lovable.app/api/public/hooks/paper-tick';
  v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
   WHERE name = 'paper_tick_cron_secret'
   LIMIT 1;

  IF v_secret IS NULL OR length(v_secret) = 0 THEN
    RAISE NOTICE 'invoke_paper_tick: paper_tick_cron_secret not set in Vault; skipping.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     => v_url,
    headers => jsonb_build_object(
      'content-type', 'application/json',
      'authorization', 'Bearer ' || v_secret
    ),
    body    => '{}'::jsonb,
    timeout_milliseconds => 20000
  );
END;
$function$;