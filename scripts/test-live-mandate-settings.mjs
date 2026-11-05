// Disposable PostgreSQL only; never contacts a venue or production database.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {PGlite}=await import(pathToFileURL(process.argv[2]).href);
const db=new PGlite();
const owner='00000000-0000-4000-8000-000000000001', stranger='00000000-0000-4000-8000-000000000002';
const plan='00000000-0000-4000-8000-000000000003', connection='00000000-0000-4000-8000-000000000004';
try {
 await db.exec(`
 create role anon;create role authenticated;create role service_role;
 create table autopilot_workflows(id uuid primary key,user_id uuid,status text,proposal jsonb,updated_at timestamptz default now(),
   max_daily_entries int default 1 constraint autopilot_workflows_daily_entries_check check(max_daily_entries between 1 and 10),
   max_open_positions int default 1,schedule_enabled boolean default true,active_days smallint[] default '{0,1,2,3,4,5,6}',
   window_start time default '00:00',window_end time default '23:59:59',timezone text default 'America/New_York',
   loss_limit numeric default 25,approved_at timestamptz default now()-interval '1 day');
 create table exchange_connections(id uuid primary key,user_id uuid,exchange text,environment text,status text,
   permission_read boolean,permission_trade boolean,permissions_verified boolean,is_live boolean);
 create table user_strategy(user_id uuid,connection_id uuid,symbol text,mode text,enabled boolean,params jsonb,updated_at timestamptz);
 create table bot_events(user_id uuid,level text,event text,detail jsonb);
 create table positions(user_id uuid,connection_id uuid,pair text,status text,autopilot_workflow_id uuid,pnl_amount numeric,updated_at timestamptz,synced_at timestamptz);
 create table order_intents(id uuid default gen_random_uuid(),user_id uuid,connection_id uuid,client_order_id text,
   environment text,venue text,symbol text,side text,reduce_only boolean,state text,created_at timestamptz default now(),
   unique(user_id,client_order_id));
 insert into autopilot_workflows(id,user_id,status,proposal) values('${plan}','${owner}','live_configured','{"setupBook":"live","enabledTurtles":["accumulator"]}');
 insert into exchange_connections values('${connection}','${owner}','apex_omni','production','verified',true,true,true,true);
 insert into user_strategy values('${owner}','${connection}','BTC-USDT','live',true,'{"autopilot_workflow_id":"${plan}","enabled_turtles":["accumulator"],"dynamic_wallet_sizing":true}',now()),
   ('${owner}','${connection}','ETH-USDT','live',true,'{"autopilot_workflow_id":"${plan}","enabled_turtles":["accumulator"],"dynamic_wallet_sizing":true}',now());
 `);
 await db.exec(await readFile(new URL('../supabase/migrations/20261003111954_reconcile_autopilot_execution_settings.sql',import.meta.url),'utf8'));
 const revision=async()=> (await db.query('select updated_at from autopilot_workflows where id=$1',[plan])).rows[0].updated_at;
 const edit=(actor,rev,leverage,daily=100,positions=6)=>db.query('select update_autopilot_execution_settings($1,$2,$3,$4,$5,$6)',[actor,plan,rev,leverage,daily,positions]);
 const insert=(key,index=1,symbol='BTC-USDT',side='BUY',reduce=false)=>db.query(
   'insert into order_intents(user_id,connection_id,client_order_id,environment,venue,symbol,side,reduce_only,state,automation_campaign_key) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
   [owner,connection,key+'-r'+index,'mainnet','apex_omni',symbol,side,reduce,'signing',key]);
 await assert.rejects(insert('missing-leverage'),/LIVE_MANDATE_LEVERAGE_REQUIRED/);
 let rev=await revision();
 await assert.rejects(edit(stranger,rev,50),/Active plan not found/);
 await assert.rejects(edit(owner,'2000-01-01T00:00:00Z',50),/changed in another session/);
 await assert.rejects(edit(owner,rev,125),/venue ceiling/);
 await assert.rejects(edit(owner,rev,50,101),/valid leverage/);
 await edit(owner,rev,50,1,1);
 assert.equal((await db.query("select count(*)::int n from user_strategy where params->>'leverage'='50' and params->>'max_daily_entries'='1'")).rows[0].n,2);
 assert.equal((await db.query("select count(*)::int n from user_strategy where enabled and mode='live'")).rows[0].n,2);
 assert.equal((await db.query("select proposal->>'leverage' lev,status from autopilot_workflows")).rows[0].lev,'50');
 assert.equal((await db.query("select is_live from exchange_connections")).rows[0].is_live,true);
 assert.equal((await db.query("select has_function_privilege('authenticated','public.update_autopilot_execution_settings(uuid,uuid,timestamptz,integer,integer,integer)','EXECUTE') allowed")).rows[0].allowed,false);
 for(let index=1;index<=5;index++)await insert('first-campaign',index);
 assert.equal((await db.query('select count(distinct autopilot_workflow_id)::int n from order_intents')).rows[0].n,1);
 await assert.rejects(insert('second-campaign',1,'ETH-USDT'),/LIVE_MANDATE_DAILY_ENTRY_LIMIT/);
 await assert.rejects(insert('first-campaign',6),/LIVE_MANDATE_CAMPAIGN_INVALID/);
 await db.query('update autopilot_workflows set max_daily_entries=100');
 await assert.rejects(insert('second-campaign',1,'ETH-USDT'),/LIVE_MANDATE_POSITION_LIMIT/);
 await db.query('update autopilot_workflows set max_open_positions=6');
 await insert('second-campaign',1,'ETH-USDT');
 await assert.rejects(insert('second-campaign',2,'BTC-USDT'),/LIVE_MANDATE_CAMPAIGN_INVALID/);
 await db.query("update autopilot_workflows set status='paused'");
 await assert.rejects(insert('paused-campaign'),/LIVE_MANDATE_NOT_ACTIVE/);
 await insert('protective-exit',1,'BTC-USDT','SELL',true);
 await db.query("update autopilot_workflows set status='live_configured',active_days='{}'");
 await assert.rejects(insert('closed-schedule'),/LIVE_MANDATE_OUTSIDE_SCHEDULE/);
 await db.query("update autopilot_workflows set active_days='{0,1,2,3,4,5,6}',window_start='22:00',window_end='02:00'");
 const hour=(await db.query("select extract(hour from now() at time zone 'America/New_York')::int current_hour")).rows[0].current_hour;
 if(hour>=2 && hour<22) await assert.rejects(insert('overnight-schedule'),/LIVE_MANDATE_OUTSIDE_SCHEDULE/);
 await db.query("update autopilot_workflows set window_start='00:00',window_end='23:59:59'");
 await db.query("insert into positions values($1,$2,'BTCUSDT','closed',$3,-25,now(),now())",[owner,connection,plan]);
 await assert.rejects(insert('loss-campaign'),/LIVE_MANDATE_LOSS_LIMIT/);
 await db.query('update positions set pnl_amount=null');
 await assert.rejects(insert('unknown-pnl'),/LIVE_MANDATE_PNL_UNCONFIRMED/);
 await db.exec('delete from positions; delete from order_intents;');
 await db.query('update autopilot_workflows set max_daily_entries=1,max_open_positions=1');
 const admission=await Promise.allSettled([insert('concurrent-a',1),insert('concurrent-b',1,'ETH-USDT')]);
 assert.equal(admission.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(admission.filter(x=>x.status==='rejected').length,1);
 await db.query("update order_intents set state='filled'");
 await db.query('update autopilot_workflows set max_daily_entries=100');
 await assert.rejects(insert('filled-unconfirmed'),/LIVE_MANDATE_POSITION_LIMIT/);
 await db.query("insert into positions values($1,$2,'BTCUSDT','closed',$3,5,now(),now()+interval '1 second')",[owner,connection,plan]);
 await insert('closed-slot-released',1,'ETH-USDT');
 // Settings mutation is one transaction: an audit failure cannot leave partial changes.
 rev=await revision();
 await db.exec("alter table bot_events add constraint reject_audit check(event<>'AUTOPILOT_EXECUTION_SETTINGS_UPDATED') not valid");
 await assert.rejects(edit(owner,rev,75),/reject_audit/);
 assert.equal((await db.query("select params->>'leverage' lev from user_strategy limit 1")).rows[0].lev,'50');
 console.log('PASS: explicit owner settings, stale revisions, venue ceiling, atomic rollback, grants, five-rung identity, daily capacity, position capacity, parallel admission, schedule, pause, realized loss, unknown PNL, reduce-only exits');
}finally{await db.close();}
