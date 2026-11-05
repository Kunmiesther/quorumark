create table public.user_ai_council (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  seats jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_ai_council_seats_array check (jsonb_typeof(seats) = 'array'),
  constraint user_ai_council_max_seats check (jsonb_array_length(seats) <= 3)
);

alter table public.user_ai_council enable row level security;
revoke all on table public.user_ai_council from anon, authenticated;
grant select on table public.user_ai_council to authenticated;
grant select, insert, update, delete on table public.user_ai_council to service_role;

create policy "Users view own AI Council"
on public.user_ai_council
for select
to authenticated
using ((select auth.uid()) = user_id);

create trigger user_ai_council_updated_at
before update on public.user_ai_council
for each row execute function public.update_updated_at_column();

comment on table public.user_ai_council is
  'User-selected advisory model seats. Provider secrets remain in Supabase Vault.';
