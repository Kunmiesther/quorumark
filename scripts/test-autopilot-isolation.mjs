// Disposable PostgreSQL only. Never connects to production.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const owner = '00000000-0000-0000-0000-000000000001';
const plan = '00000000-0000-0000-0000-000000000002';
const conn = '00000000-0000-0000-0000-000000000004';
const wallet = '00000000-0000-0000-0000-000000000005';
const read = p => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create function public._paper_assert_owner(uuid) returns void language sql as 'select';
    create table autopilot_workflows(id uuid primary key,user_id uuid,status text,proposal jsonb,
      validation jsonb,approved_at timestamptz default now()-interval '1 day',loss_limit numeric default 25,
      schedule_enabled boolean default true,active_days smallint[] default '{0,1,2,3,4,5,6}',
      window_start time default '00:00:00',window_end time default '23:59:59',timezone text default 'UTC',
      max_open_positions int default 6,max_daily_entries int default 10,paused_at timestamptz,
      pause_reason text,archived_at timestamptz,updated_at timestamptz);
    create table user_strategy(user_id uuid,connection_id uuid,symbol text,
      mode text,enabled boolean,params jsonb,updated_at timestamptz,primary key(user_id,connection_id,symbol));
    create table autopilot_risk_events(workflow_id uuid,user_id uuid,code text,detail jsonb);
    create table paper_wallets(id uuid primary key,user_id uuid,open_position_id uuid,last_tick_at timestamptz);
    create table paper_positions(id uuid primary key default gen_random_uuid(), user_id uuid,
      wallet_key text,symbol text,direction text,status text,entry_price numeric,entry_ts timestamptz,
      entry_candle_ts_ms bigint,tp_level numeric,stop_level numeric,zone_lower numeric,zone_upper numeric,zone_level numeric,
      size_qty numeric,size_notional numeric,margin numeric,leverage numeric,entry_fee numeric,opened_from_signal text,
      last_seen_candle_ts_ms bigint,trend_at_entry text,trend_slope_pct_at_entry numeric,strategy text,
      strategy_metadata jsonb default '{}',regime_at_entry text,onyx_rationale text,rung_count int,first_fill_vwap numeric,
      fills jsonb,resize_levels jsonb,pending_rungs jsonb,ladder_total_margin numeric,ladder_total_notional numeric,
      ladder_total_rungs int,configured_rung_count int,filled_rung_count int,orchestration_trace_id uuid,
      onyx_decision_id uuid,created_at timestamptz default now());
    create table paper_rung_fills(user_id uuid,position_id uuid,rung_index int,fill_price numeric,qty numeric,
      margin numeric,tp_price numeric,filled_at timestamptz,candle_ts_ms bigint,unique(position_id,rung_index));
    create table paper_trades(position_id uuid,user_id uuid,pnl_net numeric,closed_at timestamptz default now());
    insert into autopilot_workflows(id,user_id,status,proposal,pause_reason) values
      ('${plan}','${owner}','paused','{}','Automatic loss limit reached');
    insert into user_strategy values ('${owner}','${conn}','BTC-USDT','live',true,
      '{"autopilot_workflow_id":"${plan}","leverage":125}',now());
    insert into autopilot_risk_events values('${plan}','${owner}','loss_limit_reached','{"realizedPnl":-29.16}');
    insert into paper_wallets(id,user_id) values('${wallet}','${owner}');
  `);
  // Use the actual existing open function, not a mock of metadata persistence.
  const runtime = await read('supabase/migrations/20260908182229_restore_paper_engine_runtime.sql');
  await db.exec(runtime.slice(runtime.indexOf('create or replace function public.paper_open_position('),
    runtime.indexOf('create or replace function public.paper_add_rung(')));
  const migration = await read('supabase/migrations/20260926230254_autopilot_book_isolation.sql');
  await db.exec(migration); await db.exec(migration);
  const scalar = async sql => (await db.query(sql)).rows[0];
  assert.equal((await scalar('select status from autopilot_workflows')).status, 'live_configured');
  assert.equal((await scalar("select count(*)::int n from autopilot_risk_events where code='legacy_paper_pause_reconciled'")).n, 1);
  assert.deepEqual(await scalar('select mode,enabled,params->>\'leverage\' leverage from user_strategy'),
    { mode:'live',enabled:true,leverage:'125' });
  const control = (action,status) => db.query('select control_autopilot_plan($1,$2,$3,$4)', [owner,plan,action,status]);
  await assert.rejects(control('resume_paper','live_configured'), /live_plan_not_paper/);
  await assert.rejects(db.query('select control_autopilot_plan($1,$2,$3,$4)', [conn,plan,'pause','live_configured']), /plan_not_found/);
  await control('pause','live_configured');
  assert.equal((await scalar('select enabled from user_strategy')).enabled,false);
  await db.exec(`update user_strategy set mode='paper'; update autopilot_workflows set proposal='{}';`);
  await control('resume_paper','paused');
  const metadata = { autopilot_workflow_id:plan,autopilot_connection_id:conn };
  const open = () => db.query('select paper_open_position($1,$2,$3) result', [owner,wallet,JSON.stringify({
    wallet_key:'long',symbol:'BTC-USDT',direction:'long',strategy:'accumulator',entry_price:100,
    entry_ts:new Date().toISOString(),margin:5,leverage:1,strategy_metadata:metadata,
  })]);
  const position = (await open()).rows[0].result.position_id;
  assert.deepEqual((await scalar('select strategy_metadata from paper_positions')).strategy_metadata,metadata);
  await db.query('insert into paper_trades(position_id,user_id,pnl_net) values(gen_random_uuid(),$1,-999)',[owner]);
  await control('paper_loss_pause','paper_validation');
  assert.equal((await scalar('select status from autopilot_workflows')).status,'paper_validation');
  await db.query('insert into paper_trades(position_id,user_id,pnl_net) values($1,$2,-25)',[position,owner]);
  await control('paper_loss_pause','paper_validation');
  assert.equal((await scalar('select enabled from user_strategy')).enabled,false);
  await assert.rejects(open(), /paper_plan_not_active/);
  await assert.rejects(control('resume_paper','paper_validation'), /plan_changed/);
  await control('resume_paper','paused');
  await assert.rejects(open(), /paper_plan_loss_limit/);
  // An audit failure must roll back both the plan and its row.
  await db.exec(`create function reject_audit() returns trigger language plpgsql as $$ begin raise exception 'audit_unavailable'; end $$;
    create trigger reject_audit before insert on autopilot_risk_events for each row execute function reject_audit();`);
  await assert.rejects(control('pause','paper_validation'), /audit_unavailable/);
  assert.equal((await scalar('select enabled from user_strategy')).enabled,true);
  assert.equal((await scalar('select status from autopilot_workflows')).status,'paper_validation');
  await db.exec('drop trigger reject_audit on autopilot_risk_events');
  await control('archive','paper_validation');
  assert.deepEqual(await scalar('select mode,enabled from user_strategy'), {mode:'paper',enabled:false});
  assert.equal((await scalar("select has_function_privilege('authenticated','control_autopilot_plan(uuid,uuid,text,text)','EXECUTE') allowed")).allowed,false);
  assert.equal((await scalar("select has_function_privilege('service_role','control_autopilot_plan(uuid,uuid,text,text)','EXECUTE') allowed")).allowed,true);
  // Approved Live setup labels reconcile without arming or changing any row.
  const approvedMigration = await read('supabase/migrations/20260926232131_reconcile_approved_live_plan_status.sql');
  await db.exec(`update autopilot_workflows set status='awaiting_approval',proposal='{"setupBook":"live","status":"awaiting_approval"}';
    update user_strategy set mode='live',enabled=false;`);
  const beforeRows = (await db.query('select * from user_strategy')).rows;
  await db.exec('create trigger reject_audit before insert on autopilot_risk_events for each row execute function reject_audit()');
  await assert.rejects(db.exec(approvedMigration), /audit_unavailable/);
  assert.equal((await scalar('select status from autopilot_workflows')).status,'awaiting_approval');
  await db.exec('drop trigger reject_audit on autopilot_risk_events');
  for (const setup of [
    "approved_at=null",
    "approved_at=now(),proposal='{}'",
    "proposal='{\"setupBook\":\"live\"}',status='paused'",
  ]) {
    await db.exec(`update autopilot_workflows set ${setup}`);
    const before = (await db.query('select status,proposal,approved_at from autopilot_workflows')).rows;
    await db.exec(approvedMigration);
    assert.deepEqual((await db.query('select status,proposal,approved_at from autopilot_workflows')).rows,before);
  }
  await db.exec("update autopilot_workflows set status='awaiting_approval',approved_at=now(),proposal='{\"setupBook\":\"live\"}'");
  await db.exec(approvedMigration); await db.exec(approvedMigration);
  assert.equal((await scalar('select status from autopilot_workflows')).status,'live_configured');
  assert.equal((await scalar("select count(*)::int n from autopilot_risk_events where code='approved_live_configuration_reconciled'")).n,1);
  assert.deepEqual((await db.query('select * from user_strategy')).rows,beforeRows);
  // Exercise the new workflow-owned paper routes with an actual live row in
  // the same unique user/venue/symbol slot. Entire database is disposable.
  const paperPlan = '00000000-0000-0000-0000-000000000006';
  const overlappingPlan = '00000000-0000-0000-0000-000000000007';
  await db.exec(`
    create schema auth;
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.actor',true),'')::uuid $$;
    select set_config('test.actor','${owner}',false);
    alter table autopilot_workflows add column enabled_turtles text[] default '{accumulator}';
    alter table autopilot_workflows add column symbols text[] default '{BTC-USDT}';
    create table exchange_connections(id uuid primary key,user_id uuid);
    insert into exchange_connections values('${conn}','${owner}');
    create table subscriptions(user_id uuid,tier text);
    create table user_roles(user_id uuid,role text);
    create table bot_events(user_id uuid,level text,event text,detail jsonb);
    update paper_positions set status='closed';
    update paper_wallets set open_position_id=null;
  `);
  await db.exec(await read('supabase/migrations/20260927141919_paper_workflow_routes.sql'));
  const savedLiveRows = (await db.query('select * from user_strategy')).rows;
  const paperProposal = { setupBook:'paper',paperRouteVersion:1,
    venueAssignments:[{symbol:'BTC-USDT',connectionId:conn,walletConnectionId:null}] };
  await db.query('insert into autopilot_workflows(id,user_id,status,proposal) values($1,$2,$3,$4)',
    [paperPlan,owner,'paper_validation',JSON.stringify(paperProposal)]);
  assert.deepEqual((await db.query('select * from user_strategy')).rows,savedLiveRows);
  await assert.rejects(db.query('insert into autopilot_workflows(id,user_id,status,proposal) values($1,$2,$3,$4)',
    [overlappingPlan,owner,'paper_validation',JSON.stringify(paperProposal)]), /paper_route_overlap/);
  const paperControl = (action,status) => db.query('select control_autopilot_plan($1,$2,$3,$4)',[owner,paperPlan,action,status]);
  const openIndependent = (strategy, executingTurtle) => db.query('select paper_open_position($1,$2,$3) result',[owner,wallet,JSON.stringify({
    wallet_key:'long',symbol:'BTC-USDT',direction:'long',strategy,entry_price:100,
    entry_ts:new Date().toISOString(),margin:5,leverage:1,
    strategy_metadata:{autopilot_workflow_id:paperPlan,autopilot_connection_id:conn,detector_strategy:strategy,...(executingTurtle ? {executing_turtle:executingTurtle} : {})},
  })]);
  await assert.rejects(openIndependent('sweep'), /paper_plan_turtle_changed/);
  await db.exec(await read('supabase/migrations/20261003104537_separate_sweep_strategy_execution_turtle.sql'));
  await assert.rejects(openIndependent('sweep','sniper'), /paper_plan_turtle_changed/);
  await assert.rejects(openIndependent('sweep','arbiter'), /paper_plan_turtle_changed/);
  const accumulatorSweep = (await openIndependent('sweep')).rows[0].result.position_id;
  const ownedSweep = (await db.query('select strategy,strategy_metadata from paper_positions where id=$1',[accumulatorSweep])).rows[0];
  assert.equal(ownedSweep.strategy,'sweep');
  assert.equal(ownedSweep.strategy_metadata.executing_turtle,'accumulator');
  await db.query("update paper_positions set status='closed' where id=$1",[accumulatorSweep]);
  await db.query('update paper_wallets set open_position_id=null where id=$1',[wallet]);
  await db.query('select edit_autopilot_turtles($1,$2,$3)',[paperPlan,['accumulator'],['sniper','vanguard','hunter','arbiter','accumulator']]);
  await assert.rejects(db.query('select edit_autopilot_turtles($1,$2,$3)',[paperPlan,['accumulator'],['hunter']]), /changed in another session/);
  const independentPosition = (await openIndependent('sweep')).rows[0].result.position_id;
  assert.ok(independentPosition);
  assert.equal((await db.query('select strategy_metadata from paper_positions where id=$1',[independentPosition])).rows[0].strategy_metadata.executing_turtle,'sniper');
  await paperControl('pause','paper_validation');
  await assert.rejects(openIndependent('sweep'), /paper_plan_not_active/);
  await paperControl('resume_paper','paused');
  await db.query('insert into paper_trades(position_id,user_id,pnl_net) values($1,$2,-25)',[independentPosition,owner]);
  await paperControl('paper_loss_pause','paper_validation');
  assert.equal((await db.query('select status from autopilot_workflows where id=$1',[paperPlan])).rows[0].status,'paused');
  assert.deepEqual((await db.query('select * from user_strategy')).rows,savedLiveRows);
  // Cross-owner edits are denied before any entitlement/mutation step.
  await db.query("select set_config('test.actor',$1,false)",[conn]);
  await assert.rejects(db.query('select edit_autopilot_turtles($1,$2,$3)',[paperPlan,['sniper'],['hunter']]), /Active plan not found/);
  await db.query("select set_config('test.actor',$1,false)",[owner]);
  // Free paper access must not relax the live entitlement check.
  await assert.rejects(db.query('select edit_autopilot_turtles($1,$2,$3)',[plan,['accumulator'],['arbiter']]), /not available for this account/);
  assert.deepEqual((await db.query('select * from user_strategy')).rows,savedLiveRows);
  console.log('PASS: metadata persistence, book isolation, legacy repair, scoped loss, stale entry rejection, atomic rollback, archive history, grants, independent paper routes, free paper Turtle edits, live rows unchanged');
} finally { await db.close(); }
