-- Preserve existing CEX symbol sets and permit native SynFutures symbol sets.
alter table public.autopilot_workflows drop constraint autopilot_workflows_symbols_check;
alter table public.autopilot_workflows add constraint autopilot_workflows_symbols_check check (
 (cardinality(symbols) between 1 and 4 and symbols <@ array['BTC-USDT','ETH-USDT','SOL-USDT','XRP-USDT'])
 or (cardinality(symbols) between 1 and 2 and symbols <@ array['BTC-USDC','ETH-USDC']));

create function public.activate_synfutures_policy(p_user_id uuid,p_connection_id uuid,p_policy jsonb,p_proof jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare c public.exchange_connections; sid uuid; wid uuid; capital numeric; budget numeric; loss numeric; tp int; daily int; cfg jsonb; sym text;
begin
 capital:=(p_policy->>'marginUsdc')::numeric;budget:=(p_policy->>'sessionBudgetUsdc')::numeric;loss:=(p_policy->>'lossLimitUsdc')::numeric;tp:=(p_policy->>'takeProfitBps')::int;daily:=(p_policy->>'maxDailyEntries')::int;
 if capital is null or budget is null or loss is null or tp is null or daily is null or capital<=0 or capital>125 or budget<capital or budget>1250 or loss<=0 or loss>capital or tp not between 1 and 9999 or daily not between 1 and 100 or (p_policy->>'acceptMonitoredExits')::boolean is distinct from true
  or not (p_proof ?& array['operator','safe','module','block','block_hash','observed_at']) or p_proof->>'operator'='0x0000000000000000000000000000000000000000'
  or nullif(p_proof->>'operator','') is null or nullif(p_proof->>'block_hash','') is null or nullif(p_proof->>'block','') is null or nullif(p_proof->>'observed_at','') is null
  or p_proof->>'operator' !~ '^0x[0-9a-f]{40}$' or p_proof->>'block_hash' !~ '^0x[0-9a-fA-F]{64}$' or (p_proof->>'block')::numeric<=0 or (p_proof->>'observed_at')::timestamptz<clock_timestamp()-interval '30 seconds' or (p_proof->>'observed_at')::timestamptz>clock_timestamp()+interval '2 seconds' then raise exception 'SYNFUTURES_ACTIVATION_INVALID';end if;
 if not public.has_role(p_user_id,'admin') then raise exception 'OWNER_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_connection_id::text,0));
 -- Match dispatch lock order: mandate first, then connection. No campaigns may
 -- be in progress while a mandate is installed or amended.
 select id into wid from public.autopilot_workflows where user_id=p_user_id and connection_id=p_connection_id and proposal->>'native_activation'='true' order by created_at desc limit 1 for update;
 select * into c from public.exchange_connections where id=p_connection_id and user_id=p_user_id and exchange='synfutures' and environment in ('mainnet','production') and status='verified' for update;
 if c.id is null or not exists(select 1 from public.synfutures_account_registrations r join public.wallet_connections w on w.id=r.wallet_id and w.user_id=r.user_id where r.id=c.id and r.user_id=p_user_id and r.safe_address=p_proof->>'safe' and r.module_address=p_proof->>'module' and w.status='verified' and w.is_active) then raise exception 'SYNFUTURES_ACCOUNT_UNCONFIRMED';end if;
 if exists(select 1 from public.synfutures_campaigns where user_id=p_user_id and connection_id=p_connection_id and status not in ('closed','cancelled')) or exists(select 1 from public.synfutures_transactions where user_id=p_user_id and connection_id=p_connection_id and state in ('prepared','broadcast','unknown')) then raise exception 'SYNFUTURES_IN_FLIGHT';end if;
 select strategy_id into sid from public.user_strategy where user_id=p_user_id and connection_id=p_connection_id order by updated_at desc limit 1;
 if sid is null then raise exception 'SYNFUTURES_STRATEGY_REQUIRED';end if;
 if wid is null then
  insert into public.autopilot_workflows(user_id,strategy_id,goal_id,goal_label,name,authorized_capital,loss_limit,target_days,risk_mode,status,proposal,approved_at,connection_id,symbols,enabled_turtles,max_daily_entries,max_open_positions,timezone)
  values(p_user_id,sid,'synfutures-native','SynFutures native campaign','SynFutures Accumulator',capital,loss,1,'aggressive','live_configured',jsonb_build_object('setupBook','live','native_activation',true,'native_policy',p_policy,'onchain_verification',p_proof),clock_timestamp(),p_connection_id,array['BTC-USDC','ETH-USDC'],array['accumulator'],daily,1,'America/New_York') returning id into wid;
 else
  update public.autopilot_workflows set authorized_capital=capital,loss_limit=loss,max_daily_entries=daily,max_open_positions=1,status='live_configured',schedule_enabled=true,proposal=proposal||jsonb_build_object('setupBook','live','native_policy',p_policy,'onchain_verification',p_proof),updated_at=clock_timestamp() where id=wid and user_id=p_user_id;
 end if;
 cfg:=jsonb_build_object('automation_version',2,'enabled_turtles',jsonb_build_array('accumulator'),'leverage',33,'margin_usdc',p_policy->>'marginUsdc','rung_count',5,'autopilot_workflow_id',wid,'native_take_profit_bps',tp,'native_locally_monitored_exits_accepted',true,'dynamic_wallet_sizing',false,'authorized_capital',capital,'loss_limit',loss,'max_daily_entries',daily,'max_open_positions',1,'schedule_enabled',true,'active_days',jsonb_build_array(0,1,2,3,4,5,6),'window_start','00:00','window_end','23:59','timezone','America/New_York');
 foreach sym in array array['BTC-USDC','ETH-USDC'] loop
  insert into public.user_strategy(user_id,connection_id,symbol,strategy_id,market_type,cross_margin,mode,enabled,params,margin_mode)
  values(p_user_id,p_connection_id,sym,sid,'futures',true,'live',true,cfg||jsonb_build_object('symbol',sym),'cross')
  on conflict(user_id,connection_id,symbol) do update set strategy_id=excluded.strategy_id,market_type='futures',cross_margin=true,mode='live',enabled=true,params=excluded.params,margin_mode='cross',updated_at=clock_timestamp();
 end loop;
 update public.exchange_connections set is_live=true,permission_trade=true,permissions_verified=true,permission_verified_at=clock_timestamp(),last_verified_at=clock_timestamp(),permission_scopes=coalesce(permission_scopes,'{}'::jsonb)||jsonb_build_object('read_only',false,'operator_address',p_proof->>'operator','activation_proof',p_proof),last_error=null,last_error_code=null,last_error_message=null where id=p_connection_id and user_id=p_user_id;
 return true;
end; $$;
revoke all on function public.activate_synfutures_policy(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.activate_synfutures_policy(uuid,uuid,jsonb,jsonb) to service_role;
