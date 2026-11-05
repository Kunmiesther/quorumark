-- Explicit consent is required before account context is sent to a third-party
-- AI provider. The existing owner-scoped profiles RLS policy controls writes.
alter table public.profiles
  add column if not exists ai_data_consent_at timestamptz,
  add column if not exists ai_data_consent_version text;

comment on column public.profiles.ai_data_consent_at is
  'When the user explicitly allowed TurtleBot to send relevant account context to selected AI providers.';
comment on column public.profiles.ai_data_consent_version is
  'Version of the AI data-sharing disclosure accepted by the user.';

-- The original UPDATE policy had no WITH CHECK. Keep the same owner-only
-- behavior while preventing an updated row from escaping that ownership.
drop policy if exists "Users update own profile" on public.profiles;
create policy "Users update own profile"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);
