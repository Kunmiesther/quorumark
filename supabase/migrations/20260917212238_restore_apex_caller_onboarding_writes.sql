-- Restore the caller-scoped onboarding write path after the runtime schema
-- recovery intentionally recreated apex_execution_credentials as read-only.
-- The signer forwards the authenticated caller JWT; RLS remains the authority.

alter table public.apex_execution_credentials enable row level security;

-- Keep the encrypted bundle unreadable. The signer only needs these exact
-- write columns for create + revoke-and-replace.
revoke insert, update, delete
  on public.apex_execution_credentials
  from anon, authenticated;

grant insert (
  user_id,
  exchange_connection_id,
  environment,
  wallet_address,
  encrypted_credentials,
  encryption_key_version,
  credential_fingerprint,
  active
) on public.apex_execution_credentials to authenticated;

grant update (active, revoked_at, updated_at)
  on public.apex_execution_credentials
  to authenticated;

drop policy if exists "Owners can insert their apex execution credentials"
  on public.apex_execution_credentials;
create policy "Owners can insert their apex execution credentials"
  on public.apex_execution_credentials
  for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from public.exchange_connections ec
      where ec.id = exchange_connection_id
        and ec.user_id = (select auth.uid())
    )
  );

drop policy if exists "Owners can update their apex execution credentials"
  on public.apex_execution_credentials;
create policy "Owners can update their apex execution credentials"
  on public.apex_execution_credentials
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from public.exchange_connections ec
      where ec.id = exchange_connection_id
        and ec.user_id = (select auth.uid())
    )
  );

-- Append-only audit ledger used by onboarding and credential rotation.
create table if not exists public.apex_credential_audit (
  id uuid primary key default gen_random_uuid(),
  credential_id uuid references public.apex_execution_credentials(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  event text not null check (
    event in ('created', 'verified', 'rotated', 'used', 'revoked', 'signing_failed')
  ),
  detail jsonb,
  created_at timestamptz not null default now()
);

create index if not exists apex_credential_audit_user_created_idx
  on public.apex_credential_audit (user_id, created_at desc);

alter table public.apex_credential_audit enable row level security;
revoke all on public.apex_credential_audit from public, anon, authenticated;
grant select on public.apex_credential_audit to authenticated;
grant insert (credential_id, user_id, event, detail)
  on public.apex_credential_audit
  to authenticated;
grant all on public.apex_credential_audit to service_role;

drop policy if exists "user reads own credential audit"
  on public.apex_credential_audit;
create policy "user reads own credential audit"
  on public.apex_credential_audit
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Owners can insert their credential audit"
  on public.apex_credential_audit;
create policy "Owners can insert their credential audit"
  on public.apex_credential_audit
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create or replace function public.apex_credential_audit_block_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'apex_credential_audit is append-only; % is not permitted', tg_op;
end;
$$;

revoke execute on function public.apex_credential_audit_block_mutation()
  from public, anon, authenticated;

drop trigger if exists apex_credential_audit_no_update
  on public.apex_credential_audit;
create trigger apex_credential_audit_no_update
  before update on public.apex_credential_audit
  for each row execute function public.apex_credential_audit_block_mutation();

drop trigger if exists apex_credential_audit_no_delete
  on public.apex_credential_audit;
create trigger apex_credential_audit_no_delete
  before delete on public.apex_credential_audit
  for each row execute function public.apex_credential_audit_block_mutation();
