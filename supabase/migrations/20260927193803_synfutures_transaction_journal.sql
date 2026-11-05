-- Child transaction journal, not a second order-intent authority. No activation,
-- credentials, signed transaction bytes, transfers, or existing venue changes.
create table public.synfutures_transactions (
  intent_id uuid primary key references public.order_intents(id),
  user_id uuid not null references auth.users(id),
  connection_id uuid not null,
  chain_id integer not null default 8453 check (chain_id=8453),
  operator_address text not null check (operator_address ~ '^0x[0-9a-f]{40}$'),
  module_address text not null check (module_address ~ '^0x[0-9a-f]{40}$'),
  safe_address text not null check (safe_address ~ '^0x[0-9a-f]{40}$'),
  instrument_address text not null check (instrument_address in (
    '0xec6c44e704eb1932ec5fe1e4aba58db6fee71460',
    '0x04d72fb4803b4e02f14971e5bd092375eb330749')),
  operator_nonce numeric not null check (operator_nonce between 0 and 18446744073709551615 and operator_nonce=trunc(operator_nonce)),
  module_revision numeric not null check (module_revision between 0 and 115792089237316195423570985008687907853269984665640564039457584007913129639935 and module_revision=trunc(module_revision)),
  module_nonce numeric not null check (module_nonce between 0 and 115792089237316195423570985008687907853269984665640564039457584007913129639935 and module_nonce=trunc(module_nonce)),
  signed_size numeric not null check (signed_size<>0 and abs(signed_size)<=170141183460469231731687303715884105727 and signed_size=trunc(signed_size)),
  margin numeric not null check (margin between 0 and 170141183460469231731687303715884105727 and margin=trunc(margin)),
  reduce_only boolean not null,
  tx_hash text not null unique check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  state text not null default 'prepared' check (state in ('prepared','broadcast','unknown','confirmed','reverted')),
  receipt_block bigint check (receipt_block>=0),
  receipt_block_hash text check (receipt_block_hash ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(connection_id,user_id) references public.exchange_connections(id,user_id),
  unique(chain_id,operator_address,operator_nonce),
  check (operator_address<>safe_address and operator_address<>module_address and safe_address<>module_address),
  check (operator_address<>'0x0000000000000000000000000000000000000000' and module_address<>'0x0000000000000000000000000000000000000000' and safe_address<>'0x0000000000000000000000000000000000000000'),
  check (not reduce_only or margin=0),
  check ((state in ('confirmed','reverted')) = (receipt_block is not null and receipt_block_hash is not null))
);
-- One unresolved transaction per signing key / module: replicas cannot reserve
-- competing nonces. No time-based unlock after a timeout or process restart.
create unique index synfutures_operator_inflight on public.synfutures_transactions(chain_id,operator_address)
  where state in ('prepared','broadcast','unknown');
create unique index synfutures_module_inflight on public.synfutures_transactions(chain_id,module_address)
  where state in ('prepared','broadcast','unknown');
create unique index synfutures_module_replay on public.synfutures_transactions(chain_id,module_address,module_revision,module_nonce)
  where state<>'reverted';
create index synfutures_transactions_owner on public.synfutures_transactions(user_id,connection_id);
alter table public.synfutures_transactions enable row level security;
revoke all on public.synfutures_transactions from public,anon,authenticated;
grant select on public.synfutures_transactions to authenticated;
grant select,insert,update on public.synfutures_transactions to service_role;
create policy "synfutures transaction owner read" on public.synfutures_transactions
  for select to authenticated using ((select auth.uid())=user_id);

create function public.reserve_synfutures_transaction(p_user_id uuid,p_connection_id uuid,p_intent_id uuid,p_tx jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare i public.order_intents; existing public.synfutures_transactions; t public.synfutures_transactions;
begin
  if jsonb_typeof(p_tx)<>'object' or p_tx is null or (p_tx - array[
    'operator_address','module_address','safe_address','instrument_address','operator_nonce',
    'module_revision','module_nonce','signed_size','margin','reduce_only','tx_hash'])<>'{}'::jsonb then
    raise exception 'SYNFUTURES_TRANSACTION_INVALID';
  end if;
  select * into i from public.order_intents where id=p_intent_id and user_id=p_user_id
    and connection_id=p_connection_id and venue='synfutures' and environment='mainnet' for update;
  if not found or not exists(select 1 from public.exchange_connections where id=p_connection_id
    and user_id=p_user_id and exchange='synfutures' and environment in ('mainnet','production')) then
    raise exception 'SYNFUTURES_INTENT_NOT_FOUND';
  end if;
  select * into existing from public.synfutures_transactions where intent_id=i.id;
  if found then
    if (to_jsonb(existing) - array['intent_id','user_id','connection_id','chain_id','state','receipt_block',
      'receipt_block_hash','created_at','updated_at']) <> jsonb_build_object(
      'operator_address',p_tx->>'operator_address','module_address',p_tx->>'module_address',
      'safe_address',p_tx->>'safe_address','instrument_address',p_tx->>'instrument_address',
      'operator_nonce',(p_tx->>'operator_nonce')::numeric,'module_revision',(p_tx->>'module_revision')::numeric,
      'module_nonce',(p_tx->>'module_nonce')::numeric,'signed_size',(p_tx->>'signed_size')::numeric,
      'margin',(p_tx->>'margin')::numeric,'reduce_only',(p_tx->>'reduce_only')::boolean,'tx_hash',p_tx->>'tx_hash') then
      raise exception 'SYNFUTURES_INTENT_REPLAY_MISMATCH';
    end if;
    return jsonb_build_object('created',false,'tx_hash',existing.tx_hash);
  end if;
  if i.state<>'signing' or i.order_type<>'MARKET' or i.symbol not in ('BTC-USDC','ETH-USDC')
    or (p_tx->>'reduce_only')::boolean is distinct from i.reduce_only
    or (p_tx->>'signed_size')::numeric is distinct from i.size*1000000000000000000*(case when i.side='BUY' then 1 else -1 end)
    or p_tx->>'instrument_address' is distinct from (case i.symbol when 'BTC-USDC' then
      '0xec6c44e704eb1932ec5fe1e4aba58db6fee71460' else '0x04d72fb4803b4e02f14971e5bd092375eb330749' end) then
    raise exception 'SYNFUTURES_INTENT_MISMATCH';
  end if;
  insert into public.synfutures_transactions(intent_id,user_id,connection_id,operator_address,module_address,
    safe_address,instrument_address,operator_nonce,module_revision,module_nonce,signed_size,margin,reduce_only,tx_hash)
  values(i.id,i.user_id,i.connection_id,p_tx->>'operator_address',p_tx->>'module_address',p_tx->>'safe_address',
    p_tx->>'instrument_address',(p_tx->>'operator_nonce')::numeric,(p_tx->>'module_revision')::numeric,
    (p_tx->>'module_nonce')::numeric,(p_tx->>'signed_size')::numeric,(p_tx->>'margin')::numeric,
    (p_tx->>'reduce_only')::boolean,p_tx->>'tx_hash') returning * into t;
  update public.order_intents set state='reconciliation_required',exchange_order_id=t.tx_hash,
    state_reason='SYNFUTURES_TRANSACTION_PREPARED' where id=i.id;
  return jsonb_build_object('created',true,'tx_hash',t.tx_hash);
end;
$$;

create function public.observe_synfutures_transaction(p_user_id uuid,p_connection_id uuid,p_intent_id uuid,
  p_tx_hash text,p_state text,p_block bigint default null,p_block_hash text default null)
returns uuid language plpgsql security invoker set search_path='' as $$
declare t public.synfutures_transactions;
begin
  -- Same lock order as reservation: intent first, then child transaction.
  perform 1 from public.order_intents where id=p_intent_id and user_id=p_user_id and connection_id=p_connection_id for update;
  select * into t from public.synfutures_transactions where intent_id=p_intent_id and user_id=p_user_id
    and connection_id=p_connection_id and tx_hash=p_tx_hash for update;
  if not found then raise exception 'SYNFUTURES_TRANSACTION_NOT_FOUND'; end if;
  if p_state is null or p_state not in ('broadcast','unknown','confirmed','reverted')
    or (p_state in ('confirmed','reverted') and (p_block is null or p_block_hash is null))
    or (p_state in ('broadcast','unknown') and (p_block is not null or p_block_hash is not null)) then
    raise exception 'SYNFUTURES_OBSERVATION_INVALID';
  end if;
  if t.state in ('confirmed','reverted') then
    if t.state<>p_state or t.receipt_block is distinct from p_block or t.receipt_block_hash is distinct from p_block_hash then
      raise exception 'SYNFUTURES_FINALITY_CONFLICT';
    end if;
    return t.intent_id;
  end if;
  update public.synfutures_transactions set state=p_state,receipt_block=p_block,receipt_block_hash=p_block_hash,
    updated_at=clock_timestamp() where intent_id=t.intent_id;
  update public.order_intents set state=case p_state when 'confirmed' then 'filled'::public.order_intent_state
    when 'reverted' then 'failed'::public.order_intent_state when 'broadcast' then 'submitted'::public.order_intent_state
    else 'reconciliation_required'::public.order_intent_state end,
    filled_size=case when p_state='confirmed' then size else filled_size end,
    exchange_status='SYNFUTURES_'||upper(p_state),state_reason=case when p_state='unknown' then 'SYNFUTURES_RECEIPT_UNCONFIRMED'
      when p_state='reverted' then 'SYNFUTURES_TRANSACTION_REVERTED' else null end,
    last_reconciled_at=clock_timestamp() where id=t.intent_id;
  return t.intent_id;
end;
$$;
revoke all on function public.reserve_synfutures_transaction(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.observe_synfutures_transaction(uuid,uuid,uuid,text,text,bigint,text) from public,anon,authenticated;
grant execute on function public.reserve_synfutures_transaction(uuid,uuid,uuid,jsonb) to service_role;
grant execute on function public.observe_synfutures_transaction(uuid,uuid,uuid,text,text,bigint,text) to service_role;

-- uint128/256 values cross JSON as decimal strings, never IEEE-754 numbers.
create function public.list_synfutures_transactions(p_user_id uuid,p_connection_id uuid)
returns setof jsonb language sql security invoker set search_path='' as $$
  select to_jsonb(t) || jsonb_build_object('operator_nonce',t.operator_nonce::text,
    'module_revision',t.module_revision::text,'module_nonce',t.module_nonce::text,
    'signed_size',t.signed_size::text,'margin',t.margin::text)
  from public.synfutures_transactions t where t.user_id=p_user_id and t.connection_id=p_connection_id
    and t.state in ('prepared','broadcast','unknown') order by t.updated_at,t.intent_id limit 20;
$$;
revoke all on function public.list_synfutures_transactions(uuid,uuid) from public,anon,authenticated;
grant execute on function public.list_synfutures_transactions(uuid,uuid) to service_role;
