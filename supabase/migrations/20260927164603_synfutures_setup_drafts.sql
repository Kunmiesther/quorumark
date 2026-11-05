-- Configuration only. This table is deliberately not consumed by a trading worker.
create table public.synfutures_setup_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  wallet_id uuid not null references public.wallet_connections(id) on delete cascade,
  allocation_usdc numeric not null check (
    allocation_usdc > 0 and allocation_usdc < 100000000000000
    and allocation_usdc = trunc(allocation_usdc, 6)
  ),
  max_leverage integer not null check (max_leverage between 1 and 65535),
  chain_id integer not null default 8453 check (chain_id = 8453),
  status text not null default 'draft' check (status = 'draft'),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, wallet_id)
);
create index synfutures_setup_drafts_wallet_idx on public.synfutures_setup_drafts(wallet_id);
alter table public.synfutures_setup_drafts enable row level security;
revoke all on public.synfutures_setup_drafts from public, anon, authenticated;
grant select on public.synfutures_setup_drafts to authenticated;
grant select, insert, update on public.synfutures_setup_drafts to service_role;
create policy synfutures_setup_owner_read on public.synfutures_setup_drafts
  for select to authenticated using ((select auth.uid()) = user_id);

create function public.validate_synfutures_setup_draft() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.user_id <> old.user_id or new.wallet_id <> old.wallet_id or new.id <> old.id then
      raise exception 'synfutures_setup_identity_immutable';
    end if;
    new.revision := old.revision + 1;
    new.created_at := old.created_at;
  else
    new.revision := 1;
    new.created_at := now();
  end if;
  -- Serialize with wallet revocation while validating. No caller-supplied address.
  perform 1 from public.wallet_connections w
    where w.id = new.wallet_id and w.user_id = new.user_id
      and w.status = 'verified' and w.is_active = true
      and w.chain = 'ethereum' and w.network = 'mainnet'
    for share;
  if not found then raise exception 'synfutures_verified_wallet_required'; end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.validate_synfutures_setup_draft() from public, anon, authenticated;
grant execute on function public.validate_synfutures_setup_draft() to service_role;
create trigger validate_synfutures_setup_draft before insert or update
  on public.synfutures_setup_drafts for each row
  execute function public.validate_synfutures_setup_draft();
comment on table public.synfutures_setup_drafts is
  'Owner-scoped intent only; no signing authorization, collateral deposit or live route.';
