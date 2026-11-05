// Disposable PostgreSQL only; no production connection or exchange order.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const owner = '00000000-0000-0000-0000-000000000001';
const other = '00000000-0000-0000-0000-000000000002';
const read = p => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const scalar = async sql => (await db.query(sql)).rows[0];
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    insert into auth.users values('${owner}'),('${other}');
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
    create table paper_accounts(user_id uuid primary key,balance numeric default 3600,realized_pnl numeric default 0,updated_at timestamptz);
    create table paper_wallets(id uuid primary key default gen_random_uuid(),user_id uuid,wallet_key text,direction_scope text,
      balance numeric default 0,realized_pnl numeric default 0,balance_source text,status text,execution_enabled boolean default true,
      open_position_id uuid,updated_at timestamptz, unique(user_id,wallet_key));
    create table paper_positions(id uuid primary key default gen_random_uuid(),user_id uuid,wallet_key text,symbol text,direction text,
      status text,strategy text,margin numeric,orchestration_trace_id uuid,onyx_decision_id uuid,entry_candle_ts_ms bigint);
    create table paper_trades(user_id uuid,wallet_key text,pnl_net numeric);
    create table paper_test_symbols(user_id uuid,symbol text,display_name text,exchange text,max_leverage numeric,sort_order int,enabled boolean,unique(user_id,symbol));
    create table paper_engine_authority(user_id uuid primary key);
    create table user_strategy(user_id uuid,mode text,enabled boolean,params jsonb);
    insert into user_strategy values('${owner}','live',true,'{"leverage":125}');
    insert into paper_accounts(user_id,balance,realized_pnl) values('${owner}',3642,42);
  `);
  await db.exec(await read('supabase/migrations/20260914190206_four_wallet_role_orchestration.sql'));
  await db.exec(`update paper_wallets set realized_pnl=42 where user_id='${owner}' and wallet_key='long';`);
  await db.exec(await read('supabase/migrations/20260927141920_six_paper_wallet_portfolio.sql'));
  await db.exec(await read('supabase/migrations/20260927142443_paper_wallet_reductions_always_allowed.sql'));
  await db.exec(await read('supabase/migrations/20260927142820_preserve_paper_wallet_pauses.sql'));
  await db.exec(`update paper_wallets set status='paused',execution_enabled=false where user_id='${owner}' and wallet_key='hedge';`);
  await db.exec(`select configure_six_paper_wallets('${owner}');`);
  assert.equal((await scalar(`select count(*)::int n from paper_wallets where user_id='${owner}' and balance=2500`)).n,6);
  assert.deepEqual(await scalar(`select balance::text,realized_pnl::text from paper_accounts where user_id='${owner}'`),{balance:'15000',realized_pnl:'42'});
  assert.equal((await scalar(`select previous_account_balance::text b from paper_portfolio_funding where user_id='${owner}'`)).b,'3642');
  assert.equal((await scalar(`select count(*)::int n from paper_wallets where wallet_key like 'blockchain%' and execution_enabled=false and status='disabled'`)).n,2);
  await db.exec(`insert into paper_positions(user_id,wallet_key,symbol,direction,status,strategy,margin)
    values('${owner}','long','BTC-USDT','long','open','accumulator',2400);`);
  await assert.rejects(db.exec(`insert into paper_positions(user_id,wallet_key,symbol,direction,status,strategy,margin)
    values('${owner}','long','ETH-USDT','long','open','accumulator',200);`),/paper_wallet_insufficient_collateral/);
  await assert.rejects(db.exec(`update paper_positions set margin=2501 where user_id='${owner}';`),/paper_wallet_insufficient_collateral/);
  await db.exec(`begin; update paper_wallets set balance=100 where user_id='${owner}' and wallet_key='long';
    update paper_positions set margin=2300 where user_id='${owner}'; rollback;`);
  await assert.rejects(db.exec(`insert into paper_positions(user_id,wallet_key,symbol,direction,status,strategy,margin)
    values('${owner}','blockchain_evm','SOL-USDT','long','open','arbiter',100);`),/paper_wallet_role_invalid/);
  await db.exec(`update paper_positions set status='closed' where user_id='${owner}';
    insert into paper_trades values('${owner}','long',-150);
    select ensure_paper_wallets('${owner}'); select configure_six_paper_wallets('${owner}');`);
  assert.equal((await scalar(`select balance::text b from paper_wallets where user_id='${owner}' and wallet_key='long'`)).b,'2350');
  assert.equal((await scalar(`select count(*)::int n from paper_portfolio_funding where user_id='${owner}'`)).n,1);
  assert.deepEqual(await scalar(`select status,execution_enabled from paper_wallets where user_id='${owner}' and wallet_key='hedge'`),{status:'paused',execution_enabled:false});
  await db.exec(`select ensure_paper_wallets('${other}');`);
  assert.equal((await scalar(`select sum(balance)::text b from paper_wallets where user_id='${other}'`)).b,'15000');
  await db.exec(`set role authenticated; set request.jwt.claim.sub='${owner}';`);
  await assert.rejects(db.exec(`select configure_six_paper_wallets('${owner}');`),/permission denied/);
  await db.exec(`insert into paper_wallet_preferences values('${owner}','long','trust');`);
  await assert.rejects(db.exec(`insert into paper_wallet_preferences values('${other}','long','trust');`),/row-level security/);
  assert.equal((await scalar('select count(*)::int n from paper_portfolio_funding')).n,1);
  await assert.rejects(db.exec(`update paper_portfolio_funding set wallet_seed=10000;`),/permission denied/);
  await db.exec('reset role');
  assert.deepEqual(await scalar('select mode,enabled,params from user_strategy'),{mode:'live',enabled:true,params:{leverage:125}});
  console.log('PASS: six allocations; no reset on retry/tick; P&L preserved; destination-wallet margin isolation; blockchain blocked; owner RLS; live unchanged.');
} finally { await db.close(); }
