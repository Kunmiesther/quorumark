create index if not exists exchange_connections_user_idx
  on public.exchange_connections (user_id);

create index if not exists exchange_credentials_user_idx
  on public.exchange_credentials (user_id);

create index if not exists apex_execution_credentials_connection_idx
  on public.apex_execution_credentials (exchange_connection_id);
