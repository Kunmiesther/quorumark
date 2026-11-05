SELECT cron.alter_job(
  7,
  command := $cmd$
  SELECT net.http_post(
    url := 'https://project--240a6028-9d5a-4f07-b8e0-d78a3d684a1c-dev.lovable.app/api/public/hooks/paper-tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'paper_tick_cron_secret'),
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'paper_tick_apikey')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $cmd$
);