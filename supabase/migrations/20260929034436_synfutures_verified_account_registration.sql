-- Deployment identity only. NOT an exchange connection, signing session or live route.
create table public.synfutures_account_registrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  wallet_id uuid not null references public.wallet_connections(id) on delete restrict,
  setup_id uuid not null references public.synfutures_setup_drafts(id) on delete restrict,
  setup_revision integer not null check (setup_revision > 0),
  chain_id integer not null default 8453 check (chain_id = 8453),
  owner_address text not null check (owner_address ~ '^0x[0-9a-f]{40}$' and owner_address <> '0x0000000000000000000000000000000000000000'),
  safe_address text not null check (safe_address ~ '^0x[0-9a-f]{40}$' and safe_address <> owner_address and safe_address <> '0x0000000000000000000000000000000000000000'),
  module_address text not null check (module_address ~ '^0x[0-9a-f]{40}$' and module_address not in (owner_address,safe_address,'0x0000000000000000000000000000000000000000')),
  safe_proxy_code_hash text not null check (safe_proxy_code_hash ~ '^0x[0-9a-f]{64}$'),
  module_code_hash text not null check (module_code_hash ~ '^0x[0-9a-f]{64}$'),
  verified_block_number numeric(78,0) not null check (verified_block_number > 0),
  verified_block_hash text not null check (verified_block_hash ~ '^0x[0-9a-f]{64}$'),
  verified_block_time timestamptz not null,
  status text not null default 'deployed_operator_pending' check (status = 'deployed_operator_pending'),
  created_at timestamptz not null default now(),
  verified_at timestamptz not null default now(),
  unique (user_id, wallet_id), unique (chain_id, safe_address), unique (chain_id, module_address)
);
create index synfutures_registration_wallet_idx on public.synfutures_account_registrations(wallet_id);
create index synfutures_registration_setup_idx on public.synfutures_account_registrations(setup_id);
alter table public.synfutures_account_registrations enable row level security;
revoke all on public.synfutures_account_registrations from public, anon, authenticated;
grant select on public.synfutures_account_registrations to authenticated;
grant select, insert, update on public.synfutures_account_registrations to service_role;
create policy synfutures_registration_owner_read on public.synfutures_account_registrations
  for select to authenticated using ((select auth.uid()) = user_id);

create function public.validate_synfutures_account_registration() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  -- Locks protect against wallet revocation or setup edits during registration.
  perform 1 from public.synfutures_setup_drafts d
    where d.id = new.setup_id and d.user_id = new.user_id and d.wallet_id = new.wallet_id
      and d.revision = new.setup_revision and d.chain_id = 8453 for share;
  if not found then raise exception 'synfutures_setup_changed'; end if;
  perform 1 from public.wallet_connections w
    where w.id = new.wallet_id and w.user_id = new.user_id
      and lower(w.public_address) = new.owner_address
      and w.status = 'verified' and w.is_active and w.chain = 'ethereum' and w.network = 'mainnet'
    for share;
  if not found then raise exception 'synfutures_verified_owner_required'; end if;
  if new.verified_block_time < clock_timestamp() - interval '30 seconds'
    or new.verified_block_time > clock_timestamp() + interval '5 seconds' then
    raise exception 'synfutures_stale_registration';
  end if;
  if tg_op = 'UPDATE' then
    if row(new.id,new.user_id,new.wallet_id,new.setup_id,new.chain_id,new.owner_address,
      new.safe_address,new.module_address,new.safe_proxy_code_hash,new.module_code_hash)
      is distinct from row(old.id,old.user_id,old.wallet_id,old.setup_id,old.chain_id,old.owner_address,
      old.safe_address,old.module_address,old.safe_proxy_code_hash,old.module_code_hash) then
      raise exception 'synfutures_registration_identity_immutable';
    end if;
    if new.verified_block_number < old.verified_block_number
      or (new.verified_block_number = old.verified_block_number and
        (new.verified_block_hash <> old.verified_block_hash or new.verified_block_time <> old.verified_block_time)) then
      raise exception 'synfutures_registration_block_conflict';
    end if;
    new.created_at := old.created_at;
  else
    new.created_at := now();
  end if;
  new.verified_at := clock_timestamp();
  return new;
end;
$$;
revoke all on function public.validate_synfutures_account_registration() from public, anon, authenticated;
grant execute on function public.validate_synfutures_account_registration() to service_role;
create trigger validate_synfutures_account_registration before insert or update
  on public.synfutures_account_registrations for each row
  execute function public.validate_synfutures_account_registration();

create function public.register_synfutures_account(
  p_user_id uuid, p_wallet_id uuid, p_setup_revision integer,
  p_owner_address text, p_safe_address text, p_module_address text,
  p_safe_proxy_code_hash text, p_module_code_hash text,
  p_block_number text, p_block_hash text, p_block_time timestamptz
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare d public.synfutures_setup_drafts; r public.synfutures_account_registrations;
begin
  if p_block_number is null or p_block_number !~ '^[1-9][0-9]{0,77}$' then
    raise exception 'synfutures_invalid_block';
  end if;
  select * into d from public.synfutures_setup_drafts
    where user_id = p_user_id and wallet_id = p_wallet_id and revision = p_setup_revision for share;
  if not found then raise exception 'synfutures_setup_changed'; end if;
  insert into public.synfutures_account_registrations (
    user_id,wallet_id,setup_id,setup_revision,owner_address,safe_address,module_address,
    safe_proxy_code_hash,module_code_hash,verified_block_number,verified_block_hash,verified_block_time
  ) values (
    p_user_id,p_wallet_id,d.id,p_setup_revision,lower(p_owner_address),lower(p_safe_address),lower(p_module_address),
    lower(p_safe_proxy_code_hash),lower(p_module_code_hash),p_block_number::numeric,lower(p_block_hash),p_block_time
  ) on conflict (user_id,wallet_id) do update set
    setup_id=excluded.setup_id, setup_revision=excluded.setup_revision,
    owner_address=excluded.owner_address, safe_address=excluded.safe_address, module_address=excluded.module_address,
    safe_proxy_code_hash=excluded.safe_proxy_code_hash, module_code_hash=excluded.module_code_hash,
    verified_block_number=excluded.verified_block_number, verified_block_hash=excluded.verified_block_hash,
    verified_block_time=excluded.verified_block_time
  returning * into r;
  return jsonb_build_object('id',r.id,'wallet_id',r.wallet_id,'setup_revision',r.setup_revision,
    'chain_id',r.chain_id,'owner_address',r.owner_address,'safe_address',r.safe_address,
    'module_address',r.module_address,'status',r.status,'verified_at',r.verified_at,
    'verified_block_number',r.verified_block_number::text,'execution_ready',false);
end;
$$;
revoke all on function public.register_synfutures_account(uuid,uuid,integer,text,text,text,text,text,text,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.register_synfutures_account(uuid,uuid,integer,text,text,text,text,text,text,text,timestamptz)
  to service_role;
comment on table public.synfutures_account_registrations is
  'Server-attested deployment identity at an observed canonical Base block; NOT ongoing authority. Recheck ownership, code, session and permissions before every execution. Dedicated operator provisioning and live activation remain separate.';
