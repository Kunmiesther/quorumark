-- ISOLATED DISPOSABLE POSTGRES ONLY. Not a production migration.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth, public to anon, authenticated, service_role;
create table public.exchange_connections (
  id uuid primary key, user_id uuid not null references auth.users(id)
);
create function public.update_updated_at_column() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
