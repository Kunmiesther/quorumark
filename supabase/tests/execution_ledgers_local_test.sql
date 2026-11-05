-- Run against the isolated bootstrap + repair migration, never production.
-- All fixture rows roll back. No network or exchange calls are made.
begin;
insert into auth.users values
 ('00000000-0000-4000-8000-000000000001'),
 ('00000000-0000-4000-8000-000000000002');
insert into public.exchange_connections values
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001'),
 ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002');

set local role service_role;
insert into public.order_intents (user_id,connection_id,client_order_id,environment,venue,symbol,side,order_type,size,state)
 values ('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
 'fixture-order','mainnet','aster','BTCUSDT','BUY','LIMIT',0.001,'signing');
insert into public.orders (user_id,connection_id,client_order_id,symbol,side,strategy,requested_size)
 values ('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
 'fixture-order','BTCUSDT','BUY','fixture',0.001);
insert into public.order_audit (user_id,idempotency_key,phase)
 values ('00000000-0000-4000-8000-000000000001','fixture-order','received');
do $$ begin
  begin
    insert into public.order_intents (user_id,connection_id,client_order_id,environment,venue,symbol,side,order_type,size)
      select user_id,connection_id,client_order_id,environment,venue,symbol,side,order_type,size from public.order_intents;
    raise exception 'duplicate intent was accepted';
  exception when unique_violation then null; end;
  begin
    insert into public.orders (user_id,connection_id,client_order_id,symbol,side,strategy,requested_size)
      select user_id,connection_id,client_order_id,symbol,side,strategy,requested_size from public.orders;
    raise exception 'duplicate exchange order was accepted';
  exception when unique_violation then null; end;
  begin
    insert into public.order_intents (user_id,connection_id,client_order_id,environment,venue,symbol,side,order_type,size)
    values ('00000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',
    'wrong-owner','mainnet','aster','BTCUSDT','BUY','LIMIT',0.001);
    raise exception 'cross-owner connection was accepted';
  exception when foreign_key_violation then null; end;
  begin
    update public.order_audit set phase='submitted';
    raise exception 'service role can rewrite audit';
  exception when insufficient_privilege then null; end;
end $$;
-- Two retries cannot both acquire the same signing row.
do $$ declare affected integer; begin
  update public.order_intents set state='submitted', exchange_order_id='fixture-venue-id'
    where client_order_id='fixture-order' and state='signing';
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'first transition failed'; end if;
  update public.order_intents set state='rejected'
    where client_order_id='fixture-order' and state='signing';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'replayed transition overwrote submission'; end if;
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
do $$ declare table_name text; n integer; begin
  foreach table_name in array array['order_intents','orders','order_audit'] loop
    execute format('select count(*) from public.%I',table_name) into n;
    if n <> 1 then raise exception 'owner cannot read %',table_name; end if;
    if has_table_privilege(current_user,'public.'||table_name,'INSERT')
      or has_table_privilege(current_user,'public.'||table_name,'UPDATE')
      or has_table_privilege(current_user,'public.'||table_name,'DELETE') then
      raise exception 'client write access on %',table_name;
    end if;
  end loop;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000002';
do $$ declare table_name text; n integer; begin
  foreach table_name in array array['order_intents','orders','order_audit'] loop
    execute format('select count(*) from public.%I',table_name) into n;
    if n <> 0 then raise exception 'cross-owner disclosure on %',table_name; end if;
  end loop;
end $$;

set local role anon;
do $$ declare table_name text; begin
  foreach table_name in array array['order_intents','orders','order_audit'] loop
    if has_table_privilege(current_user,'public.'||table_name,'SELECT')
      or has_table_privilege(current_user,'public.'||table_name,'INSERT') then
      raise exception 'anonymous ledger access on %',table_name;
    end if;
  end loop;
end $$;
reset role;
-- Even a privileged writer cannot mutate append-only audit rows.
do $$ begin
  begin
    delete from public.order_audit;
    raise exception 'audit deletion was accepted';
  exception when raise_exception then
    if sqlerrm not like 'order_audit is append-only;%' then raise; end if;
  end;
end $$;
rollback;
select 'execution ledger ownership, permissions, replay, audit tests passed' as result;
