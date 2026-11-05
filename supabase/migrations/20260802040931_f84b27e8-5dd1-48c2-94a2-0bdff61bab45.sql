select vault.create_secret('ed885041a040ebc3dd02a6a2787e65ed41c6c8979387c88d57c8b58cae4f56c8', 'ai_advisory_cron_secret', 'Bearer secret for /api/public/hooks/ai-advisory');

select cron.schedule(
  'ai-advisory-sweep',
  '*/2 * * * *',
  $cmd$
  SELECT net.http_post(
    url := 'https://project--240a6028-9d5a-4f07-b8e0-d78a3d684a1c-dev.lovable.app/api/public/hooks/ai-advisory',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'ai_advisory_cron_secret'),
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'paper_tick_apikey')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $cmd$
);