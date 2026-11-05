create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.invoke_paper_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'paper_tick_base_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'paper_tick_apikey';
  if v_url is null or v_key is null then
    raise notice 'invoke_paper_tick: paper_tick_base_url / paper_tick_apikey not set in Vault; skipping.';
    return;
  end if;
  perform net.http_post(
    url     => rtrim(v_url, '/') || '/api/public/hooks/paper-tick',
    headers => jsonb_build_object('content-type', 'application/json', 'apikey', v_key),
    body    => '{}'::jsonb,
    timeout_milliseconds => 8000
  );
end;
$$;

revoke all on function public.invoke_paper_tick() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'paper-tick-every-minute') then
    perform cron.unschedule('paper-tick-every-minute');
  end if;
end $$;

select cron.schedule('paper-tick-every-minute', '* * * * *', $cron$select public.invoke_paper_tick();$cron$);