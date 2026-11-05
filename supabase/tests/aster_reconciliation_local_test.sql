-- Isolated PostgreSQL only; no live account, credentials or venue calls.
begin;
insert into auth.users values ('00000000-0000-4000-8000-000000000001');
insert into public.exchange_connections values
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001');
insert into public.order_intents (id,user_id,connection_id,client_order_id,environment,venue,symbol,side,order_type,size,state,exchange_order_id)
 values ('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',
 '10000000-0000-4000-8000-000000000001','tb-fixture','mainnet','aster','ETHUSDT','BUY','LIMIT',1,'submitted','strategy-1');
set local role service_role;
do $$ declare r public.order_intents; begin
  perform public.reconcile_aster_order('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001','entry-1','PARTIALLY_FILLED',0.4);
  select * into r from public.order_intents where client_order_id='tb-fixture';
  if r.filled_size <> 0.4 or r.state <> 'partially_filled' or r.exchange_order_id <> 'strategy-1'
    or r.aster_order_id <> 'entry-1' then raise exception 'partial fill/strategy identity not persisted'; end if;
  -- The exact observation is idempotent.
  perform public.reconcile_aster_order(r.user_id,r.connection_id,r.id,'entry-1','PARTIALLY_FILLED',0.4);
  begin
    perform public.reconcile_aster_order(r.user_id,r.connection_id,r.id,'entry-1','NEW',0);
    raise exception 'regressive fill accepted';
  exception when raise_exception then
    if sqlerrm <> 'ASTER_OBSERVATION_MISMATCH' then raise; end if;
  end;
  begin
    perform public.reconcile_aster_order(r.user_id,r.connection_id,r.id,'different-entry','FILLED',1);
    raise exception 'changed order identity accepted';
  exception when raise_exception then
    if sqlerrm <> 'ASTER_OBSERVATION_MISMATCH' then raise; end if;
  end;
  begin
    perform public.reconcile_aster_order(r.user_id,'10000000-0000-4000-8000-000000000002',r.id,'entry-1','FILLED',1);
    raise exception 'wrong connection accepted';
  exception when raise_exception then
    if sqlerrm <> 'ASTER_INTENT_NOT_FOUND' then raise; end if;
  end;
  perform public.reconcile_aster_order(r.user_id,r.connection_id,r.id,null,'UNKNOWN',null);
  select * into r from public.order_intents where id=r.id;
  if r.state <> 'reconciliation_required' or r.filled_size <> 0.4 then raise exception 'unknown erased fill'; end if;
  perform public.reconcile_aster_order(r.user_id,r.connection_id,r.id,'entry-1','CANCELED',0.6);
  perform public.reconcile_aster_order(r.user_id,r.connection_id,r.id,null,'UNKNOWN',null);
  select * into r from public.order_intents where client_order_id='tb-fixture';
  if r.state <> 'cancelled' or r.filled_size <> 0.6 then raise exception 'terminal observation overwritten'; end if;
  begin
    perform public.reconcile_aster_order(r.user_id,r.connection_id,r.id,'entry-1','PARTIALLY_FILLED',0.6);
    raise exception 'terminal state reopened';
  exception when raise_exception then
    if sqlerrm <> 'ASTER_TERMINAL_STATE_CONFLICT' then raise; end if;
  end;
end $$;
do $$ declare r public.order_intents; begin
  select * into r from public.order_intents where client_order_id='tb-fixture';
  insert into public.order_intents(user_id,connection_id,client_order_id,aster_campaign_key,environment,venue,symbol,side,order_type,size,state)
    values (r.user_id,r.connection_id,'rung-one','campaign-one','mainnet','aster','SOLUSDT','BUY','LIMIT',1,'signing'),
           (r.user_id,r.connection_id,'rung-two','campaign-one','mainnet','aster','SOLUSDT','BUY','LIMIT',1,'signing');
  begin
    insert into public.order_intents(user_id,connection_id,client_order_id,aster_campaign_key,environment,venue,symbol,side,order_type,size,state)
    values (r.user_id,r.connection_id,'competing-rung','campaign-two','mainnet','aster','SOLUSDT','BUY','LIMIT',1,'signing');
    raise exception 'concurrent campaign accepted';
  exception when raise_exception then
    if sqlerrm <> 'ASTER_SYMBOL_HAS_UNRESOLVED_INTENT' then raise; end if;
  end;
  begin
    insert into public.order_intents(user_id,connection_id,client_order_id,environment,venue,symbol,side,order_type,size,state,reduce_only)
    values (r.user_id,r.connection_id,'racing-exit','mainnet','aster','SOLUSDT','SELL','MARKET',1,'signing',true);
    raise exception 'close raced unresolved entries';
  exception when raise_exception then
    if sqlerrm <> 'ASTER_SYMBOL_HAS_UNRESOLVED_INTENT' then raise; end if;
  end;
  update public.order_intents set state='cancelled' where aster_campaign_key='campaign-one';
  insert into public.order_intents(user_id,connection_id,client_order_id,environment,venue,symbol,side,order_type,size,state,reduce_only)
    values (r.user_id,r.connection_id,'confirmed-exit','mainnet','aster','SOLUSDT','SELL','MARKET',1,'signing',true);
end $$;
reset role;
do $$ begin
  if has_function_privilege('authenticated','public.reconcile_aster_order(uuid,uuid,uuid,text,text,numeric)','EXECUTE')
    or has_function_privilege('anon','public.reconcile_aster_order(uuid,uuid,uuid,text,text,numeric)','EXECUTE') then
    raise exception 'client can rewrite execution evidence';
  end if;
end $$;
rollback;
select 'PASS: Aster monotonic reconciliation, replay, connection ownership, terminal states, client denial' as result;
