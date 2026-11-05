-- DISPOSABLE LOCAL DATABASE ONLY. Minimal wallet shape; production migrations
-- provide the real wallet table. No exchange, order, session or funding writes.
create table public.wallet_connections (
  id uuid primary key, user_id uuid not null references auth.users(id),
  public_address text not null, status text not null, is_active boolean not null,
  chain text not null, network text not null
);
grant select, update on public.wallet_connections to service_role;
insert into auth.users values
 ('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');
insert into public.wallet_connections values (
 '10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',
 '0x1111111111111111111111111111111111111111','verified',true,'ethereum','mainnet'
);
