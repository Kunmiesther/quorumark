-- DISPOSABLE LOCAL DATABASE ONLY. Executed against the actual migrations.
begin;
insert into public.synfutures_setup_drafts(user_id,wallet_id,allocation_usdc,max_leverage)
values('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',100,33);
set local role service_role;
do $$ declare
  u uuid='00000000-0000-4000-8000-000000000001'; w uuid='10000000-0000-4000-8000-000000000001';
  owner_address text='0x'||repeat('1',40); safe_address text='0x'||repeat('2',40); module_address text='0x'||repeat('3',40);
  t timestamptz=date_trunc('second',clock_timestamp()); r jsonb; again jsonb;
begin
  r=public.register_synfutures_account(u,w,1,owner_address,safe_address,module_address,
    '0x'||repeat('a',64),'0x'||repeat('b',64),'9007199254740993','0x'||repeat('c',64),t);
  if r->>'status'<>'deployed_operator_pending' or r->'execution_ready'<>'false'::jsonb
    or r->>'verified_block_number'<>'9007199254740993' then raise exception 'incorrect registration result'; end if;
  again=public.register_synfutures_account(u,w,1,owner_address,safe_address,module_address,
    '0x'||repeat('a',64),'0x'||repeat('b',64),'9007199254740993','0x'||repeat('c',64),t);
  if again->>'id'<>r->>'id' or (select count(*) from public.synfutures_account_registrations)<>1 then
    raise exception 'retry duplicated account'; end if;
  begin
    perform public.register_synfutures_account('00000000-0000-4000-8000-000000000002',w,1,owner_address,safe_address,module_address,
      '0x'||repeat('a',64),'0x'||repeat('b',64),'9007199254740993','0x'||repeat('c',64),t);
    raise exception 'foreign owner allowed';
  exception when raise_exception then if sqlerrm<>'synfutures_setup_changed' then raise; end if; end;
  begin
    perform public.register_synfutures_account(u,w,2,owner_address,safe_address,module_address,
      '0x'||repeat('a',64),'0x'||repeat('b',64),'9007199254740993','0x'||repeat('c',64),t);
    raise exception 'stale revision allowed';
  exception when raise_exception then if sqlerrm<>'synfutures_setup_changed' then raise; end if; end;
end $$;
reset role;
do $$ declare r public.synfutures_account_registrations; v text; expected text;
begin
  select * into r from public.synfutures_account_registrations;
  foreach v in array array['owner','revoked','inactive','chain','network','safe','module','proxyHash','moduleHash',
    'blockRegression','blockHash','blockTime','stale','future','fractional','nullBlock'] loop
    expected=case
      when v in ('owner','revoked','inactive','chain','network') then 'synfutures_verified_owner_required'
      when v in ('safe','module','proxyHash','moduleHash') then 'synfutures_registration_identity_immutable'
      when v in ('blockRegression','blockHash','blockTime') then 'synfutures_registration_block_conflict'
      when v in ('stale','future') then 'synfutures_stale_registration'
      else 'synfutures_invalid_block' end;
    begin
      if v='revoked' then update public.wallet_connections set status='revoked'; end if;
      if v='inactive' then update public.wallet_connections set is_active=false; end if;
      if v='chain' then update public.wallet_connections set chain='solana'; end if;
      if v='network' then update public.wallet_connections set network='testnet'; end if;
      perform public.register_synfutures_account(r.user_id,r.wallet_id,r.setup_revision,
        case when v='owner' then '0x'||repeat('9',40) else r.owner_address end,
        case when v='safe' then '0x'||repeat('9',40) else r.safe_address end,
        case when v='module' then '0x'||repeat('9',40) else r.module_address end,
        case when v='proxyHash' then '0x'||repeat('d',64) else r.safe_proxy_code_hash end,
        case when v='moduleHash' then '0x'||repeat('d',64) else r.module_code_hash end,
        case v when 'blockRegression' then '1' when 'fractional' then '1.1' when 'nullBlock' then null else r.verified_block_number::text end,
        case when v='blockHash' then '0x'||repeat('d',64) else r.verified_block_hash end,
        case v when 'stale' then clock_timestamp()-interval '31 seconds'
          when 'future' then clock_timestamp()+interval '6 seconds'
          when 'blockTime' then r.verified_block_time-interval '1 second' else r.verified_block_time end);
      raise exception 'bad registration allowed: %',v;
    exception when raise_exception then if sqlerrm<>expected then raise; end if; end;
  end loop;
  -- Saving new settings invalidates the old revision, but preserves the account identity.
  update public.synfutures_setup_drafts set max_leverage=32;
  begin
    perform public.register_synfutures_account(r.user_id,r.wallet_id,1,r.owner_address,r.safe_address,r.module_address,
      r.safe_proxy_code_hash,r.module_code_hash,r.verified_block_number::text,r.verified_block_hash,r.verified_block_time);
    raise exception 'old draft accepted';
  exception when raise_exception then if sqlerrm<>'synfutures_setup_changed' then raise; end if; end;
  if public.register_synfutures_account(r.user_id,r.wallet_id,2,r.owner_address,r.safe_address,r.module_address,
      r.safe_proxy_code_hash,r.module_code_hash,r.verified_block_number::text,r.verified_block_hash,r.verified_block_time)->>'id' <> r.id::text then
    raise exception 'settings edit replaced account'; end if;
  if exists(select 1 from public.exchange_connections) then raise exception 'registration created an exchange connection'; end if;
  if not (select relrowsecurity from pg_class where oid='public.synfutures_account_registrations'::regclass) then
    raise exception 'RLS missing'; end if;
  if has_function_privilege('anon','public.register_synfutures_account(uuid,uuid,integer,text,text,text,text,text,text,text,timestamptz)','EXECUTE')
    or has_function_privilege('authenticated','public.register_synfutures_account(uuid,uuid,integer,text,text,text,text,text,text,text,timestamptz)','EXECUTE')
    or has_table_privilege('authenticated','public.synfutures_account_registrations','INSERT,UPDATE,DELETE')
    or has_table_privilege('anon','public.synfutures_account_registrations','SELECT') then raise exception 'client grants leaked'; end if;
  if exists(select 1 from pg_proc where proname in ('register_synfutures_account','validate_synfutures_account_registration')
      and (prosecdef or not ('search_path=""'=any(proconfig)))) then raise exception 'unsafe function configuration'; end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
do $$ begin if exists(select 1 from public.synfutures_account_registrations) then raise exception 'foreign account visible'; end if; end $$;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$ begin if (select count(*) from public.synfutures_account_registrations)<>1 then raise exception 'own account hidden'; end if; end $$;
reset role;
rollback;
select 'PASS: registration identity, revision locks, retries, wallet revocation, freshness, RLS and service-only writes' as result;
