create table if not exists public.push_device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token text not null,
  platform text not null check (platform in ('ios', 'android')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (user_id, token)
);

alter table public.push_device_tokens enable row level security;

revoke all on table public.push_device_tokens from anon;
grant select, insert, update, delete on table public.push_device_tokens to authenticated;

create policy "Users can read their push devices"
  on public.push_device_tokens for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can register their push devices"
  on public.push_device_tokens for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can refresh their push devices"
  on public.push_device_tokens for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can remove their push devices"
  on public.push_device_tokens for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create index if not exists push_device_tokens_user_id_idx
  on public.push_device_tokens (user_id);
