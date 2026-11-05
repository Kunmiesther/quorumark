-- Transactional production contract test. It opens and closes one synthetic
-- paper position, verifies accounting/idempotency/lease behavior, then removes
-- every fixture before this migration commits.
do $smoke$
declare
  v_user uuid;
  v_wallet uuid := gen_random_uuid();
  v_position uuid;
  v_result jsonb;
  v_balance numeric;
  v_realized numeric;
  v_status text;
  v_bucket timestamptz := date_trunc('minute', now() + interval '10 years');
  v_key text := 'smoke:' || gen_random_uuid()::text;
begin
  select id into v_user from auth.users order by created_at limit 1;
  if v_user is null then raise exception 'smoke_requires_existing_user'; end if;
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select balance, realized_pnl into v_balance, v_realized
    from public.paper_accounts where user_id = v_user;
  insert into public.paper_test_symbols
    (user_id, symbol, display_name, exchange, enabled, max_leverage, sort_order)
  values (v_user, 'SMOKE-USDT', 'SMOKE', 'test_fixture', true, 1, 9999);
  insert into public.paper_wallets
    (id, user_id, wallet_key, direction_scope, execution_enabled)
  values (v_wallet, v_user, 'SMOKE-long', 'long', true);

  v_result := public.paper_open_position(v_user, v_wallet, jsonb_build_object(
    'wallet_key','SMOKE-long','symbol','SMOKE-USDT','direction','long',
    'entry_price',100,'entry_ts',now(),'entry_candle_ts_ms',extract(epoch from now())::bigint * 1000,
    'tp_level',101,'stop_level',99,'zone_lower',99,'zone_upper',101,'zone_level',100,
    'size_qty',1,'size_notional',100,'margin',100,'leverage',1,'entry_fee',0,
    'last_seen_candle_ts_ms',extract(epoch from now())::bigint * 1000,
    'strategy','smoke','rung_count',1,
    'fills',jsonb_build_array(jsonb_build_object('price',100,'qty',1,'margin',100,'tp',101))
  ));
  v_position := (v_result->>'position_id')::uuid;
  if not exists (select 1 from public.paper_positions where id=v_position and status='open') then
    raise exception 'smoke_open_failed';
  end if;
  if (select open_position_id from public.paper_wallets where id=v_wallet) is distinct from v_position then
    raise exception 'smoke_wallet_link_failed';
  end if;

  perform public.paper_close_position(v_user, v_position, null,
    jsonb_build_array(jsonb_build_object(
      'wallet_key','SMOKE-long','symbol','SMOKE-USDT','direction','long',
      'entry_price',100,'exit_price',100.5,'exit_reason','paper_reset',
      'size_qty',1,'size_notional',100,'margin',100,'leverage',1,
      'pnl_gross',0.5,'fees',0,'slippage_cost',0,'pnl_net',0.5,
      'hold_seconds',60,'opened_at',now()-interval '1 minute','closed_at',now()
    )), 0.5, v_wallet,
    jsonb_build_object('trades_delta',1,'wins_delta',1,'losses_delta',0));
  if not exists (select 1 from public.paper_positions where id=v_position and status='closed') then
    raise exception 'smoke_close_failed';
  end if;
  if not exists (select 1 from public.paper_trades where position_id=v_position and pnl_net=0.5) then
    raise exception 'smoke_trade_ledger_failed';
  end if;
  if (select balance from public.paper_accounts where user_id=v_user) <> v_balance + 0.5 then
    raise exception 'smoke_accounting_failed';
  end if;

  select status into v_status
    from public.claim_paper_engine_operation(v_user, v_key, 'smoke-fingerprint');
  if v_status <> 'claimed' then raise exception 'smoke_operation_claim_failed'; end if;
  perform public.complete_paper_engine_operation(v_user, v_key, jsonb_build_object('ok',true));
  select status into v_status
    from public.claim_paper_engine_operation(v_user, v_key, 'smoke-fingerprint');
  if v_status <> 'replayed' then raise exception 'smoke_operation_replay_failed'; end if;
  if not public.claim_paper_tick(v_user, v_bucket) then raise exception 'smoke_tick_claim_failed'; end if;
  if public.claim_paper_tick(v_user, v_bucket) then raise exception 'smoke_tick_duplicate_failed'; end if;

  delete from public.paper_engine_operations where user_id=v_user and op_key=v_key;
  delete from public.paper_tick_leases where user_id=v_user and minute_bucket=v_bucket;
  delete from public.paper_trades where position_id=v_position;
  delete from public.paper_positions where id=v_position;
  delete from public.paper_wallets where id=v_wallet;
  delete from public.paper_test_symbols where user_id=v_user and symbol='SMOKE-USDT';
  update public.paper_accounts set balance=v_balance, realized_pnl=v_realized where user_id=v_user;
end
$smoke$;
