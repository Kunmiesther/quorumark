update public.exchange_connections
set last_verified_at = now(), updated_at = now()
where id = '4a6cec71-0f1f-423f-8979-25edf2e77b7d'::uuid
  and status = 'verified';