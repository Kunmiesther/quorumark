select cron.schedule(
  'tp-council-1m',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://project--240a6028-9d5a-4f07-b8e0-d78a3d684a1c.lovable.app/api/public/hooks/tp-council',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'ai_advisory_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
  $$
);