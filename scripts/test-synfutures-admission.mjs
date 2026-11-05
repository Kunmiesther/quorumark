// Executes the real PL/pgSQL trigger in disposable PostgreSQL. No venue/network.
import {readFile, readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
const dir=new URL('../supabase/migrations/',import.meta.url);
const migration=process.argv[2] ?? new URL((await readdir(dir)).find(x=>x.endsWith('_synfutures_campaign_admission.sql')),dir);
const db=new PGlite();
const owner='00000000-0000-4000-8000-000000000001', stranger='00000000-0000-4000-8000-000000000002';
const plan='00000000-0000-4000-8000-000000000003', connection='00000000-0000-4000-8000-000000000004';
let checks=0;
try {
 await db.exec(`
 create table autopilot_workflows(id uuid primary key,user_id uuid,status text,proposal jsonb,updated_at timestamptz default now(),
   max_daily_entries int default 1,max_open_positions int default 1,schedule_enabled boolean default true,
   active_days smallint[] default '{0,1,2,3,4,5,6}',window_start time default '00:00',window_end time default '23:59:59',
   timezone text default 'UTC',loss_limit numeric default 25,approved_at timestamptz default now()-interval '1 day');
 create table exchange_connections(id uuid primary key,user_id uuid,exchange text,environment text,status text,
   permission_trade boolean,permissions_verified boolean,is_live boolean,permission_read boolean default true);
 create table user_strategy(user_id uuid,connection_id uuid,symbol text,mode text,enabled boolean,params jsonb,updated_at timestamptz default now());
 create table bot_events(user_id uuid,level text,event text,detail jsonb);
 create table positions(user_id uuid,connection_id uuid,pair text,status text,autopilot_workflow_id uuid,pnl_amount numeric,updated_at timestamptz,synced_at timestamptz);
 create table order_intents(id uuid default gen_random_uuid(),user_id uuid,connection_id uuid,client_order_id text,
   environment text,venue text,symbol text,side text,order_type text,reduce_only boolean,state text,
   automation_campaign_key text,autopilot_workflow_id uuid,created_at timestamptz default now(),unique(user_id,client_order_id));
 insert into autopilot_workflows(id,user_id,status,proposal) values('${plan}','${owner}','live_configured','{"setupBook":"live"}');
 insert into exchange_connections(id,user_id,exchange,environment,status,permission_trade,permissions_verified,is_live) values('${connection}','${owner}','synfutures','mainnet','verified',true,true,true);
 insert into user_strategy(user_id,connection_id,symbol,mode,enabled,params) values('${owner}','${connection}','BTC-USDC','live',true,'{"autopilot_workflow_id":"${plan}","leverage":33}'),
   ('${owner}','${connection}','ETH-USDC','live',true,'{"autopilot_workflow_id":"${plan}","leverage":33}');
 `);
 await db.exec(await readFile(migration,'utf8'));
 const settings=process.argv[3] ?? new URL((await readdir(dir)).find(x=>x.endsWith('_synfutures_execution_settings.sql')),dir);
 await db.exec(await readFile(settings,'utf8'));
 await db.exec('create trigger admission before insert on order_intents for each row execute function validate_live_mandate_entry()');
 const insert=(key,rung=1,overrides={})=>{
   const r={user_id:owner,connection_id:connection,client_order_id:`${key ?? 'missing'}-r${rung}`,environment:'mainnet',venue:'synfutures',
     symbol:'BTC-USDC',side:'BUY',order_type:'MARKET',reduce_only:false,state:'signing',automation_campaign_key:key,...overrides};
   return db.query('insert into order_intents('+Object.keys(r).join(',')+') values('+Object.keys(r).map((_,i)=>'$'+(i+1)).join(',')+') returning autopilot_workflow_id',Object.values(r));
 };
 const reject=async(p,code)=>{await assert.rejects(p,new RegExp(code));checks++;};
 const reset=()=>db.exec('delete from positions;delete from order_intents;update autopilot_workflows set max_daily_entries=1,max_open_positions=1');
 const revision=async()=>(await db.query('select updated_at from autopilot_workflows where id=$1',[plan])).rows[0].updated_at;
 const edit=(actor,rev,leverage)=>db.query('select update_autopilot_execution_settings($1,$2,$3,$4,1,1)',[actor,plan,rev,leverage]);
 await reject(edit(stranger,await revision(),33),'Active plan not found');
 await reject(edit(owner,'2000-01-01T00:00:00Z',33),'changed in another session');
 await reject(edit(owner,await revision(),34),'venue ceiling');
 await edit(owner,await revision(),33);
 assert.equal((await db.query("select count(*)::int n from user_strategy where params->>'leverage'='33' and enabled")).rows[0].n,2);checks++;
 assert.equal((await db.query('select is_live,permission_trade,permissions_verified from exchange_connections')).rows[0].is_live,true);
 await db.exec('update exchange_connections set permission_trade=false');
 await reject(edit(owner,await revision(),32),'not a verified supported live venue');
 await db.exec('update exchange_connections set permission_trade=true');
 await reject(insert(null),'LIVE_MANDATE_CAMPAIGN_REQUIRED');
 await reject(insert('short'),'LIVE_MANDATE_CAMPAIGN_INVALID');
 await reject(insert('wrong-env',1,{environment:'testnet'}),'LIVE_MANDATE_CAMPAIGN_INVALID');
 await reject(insert('wrong-owner',1,{user_id:stranger}),'LIVE_MANDATE_NOT_CONFIGURED');
 await db.exec('update user_strategy set params=params || \'{"leverage":34}\'');
 await reject(insert('above-leverage'),'LIVE_MANDATE_LEVERAGE_REQUIRED');
 await db.exec('update user_strategy set params=params || \'{"leverage":32.5}\'');
 await reject(insert('fractional-leverage'),'LIVE_MANDATE_LEVERAGE_REQUIRED');
 await db.exec('update user_strategy set params=params || \'{"leverage":33}\'');
 await reject(insert('wrong-order',1,{order_type:'LIMIT'}),'LIVE_MANDATE_NATIVE_MARKET_INVALID');
 await reject(insert('wrong-symbol',1,{symbol:'SOL-USDC'}),'LIVE_MANDATE_NOT_CONFIGURED');
 for(const field of ['permission_trade','permissions_verified','is_live']){
   await db.exec(`update exchange_connections set ${field}=false`);
   await reject(insert('disabled-'+field),'LIVE_MANDATE_NATIVE_PERMISSION_REQUIRED');
   await db.exec(`update exchange_connections set ${field}=true`);
 }
 await db.query('update exchange_connections set user_id=$1',[stranger]);
 await reject(insert('connection-owner'),'LIVE_MANDATE_NATIVE_PERMISSION_REQUIRED');
 await db.query('update exchange_connections set user_id=$1,environment=$2',[owner,'production']);
 for(let rung=1;rung<=5;rung++)assert.equal((await insert('first-campaign',rung)).rows[0].autopilot_workflow_id,plan);
 checks++;
 await reject(insert('first-campaign',6),'LIVE_MANDATE_CAMPAIGN_INVALID');
 await reject(insert('first-campaign',6,{side:'SELL'}),'LIVE_MANDATE_CAMPAIGN_INVALID');
 await reject(insert('second-campaign',1,{symbol:'ETH-USDC'}),'LIVE_MANDATE_DAILY_ENTRY_LIMIT');
 await db.exec('update autopilot_workflows set max_daily_entries=10');
 await reject(insert('second-campaign',1,{symbol:'ETH-USDC'}),'LIVE_MANDATE_POSITION_LIMIT');
 await db.exec('update autopilot_workflows set max_open_positions=2');
 await insert('second-campaign',1,{symbol:'ETH-USDC'});checks++;
 await reject(insert('second-campaign',2,{symbol:'BTC-USDC'}),'LIVE_MANDATE_CAMPAIGN_INVALID');
 await db.exec("update autopilot_workflows set status='paused'");
 await reject(insert('paused-campaign'),'LIVE_MANDATE_NOT_ACTIVE');
 await insert(null,1,{client_order_id:'protective-exit',reduce_only:true,side:'SELL'});checks++;
 await db.exec("update autopilot_workflows set status='live_configured',active_days='{}'");
 await reject(insert('outside-schedule'),'LIVE_MANDATE_OUTSIDE_SCHEDULE');
 await db.exec("update autopilot_workflows set active_days='{0,1,2,3,4,5,6}'");
 await db.query("insert into positions values($1,$2,'BTCUSDC','closed',$3,null,now(),now())",[owner,connection,plan]);
 await reject(insert('unknown-pnl'),'LIVE_MANDATE_PNL_UNCONFIRMED');
 await db.exec('update positions set pnl_amount=-25');
 await reject(insert('loss-limit'),'LIVE_MANDATE_LOSS_LIMIT');
 await reset();
 const results=await Promise.allSettled([insert('concurrent-a'),insert('concurrent-b',1,{symbol:'ETH-USDC'})]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.match(results.find(x=>x.status==='rejected').reason.message,/LIVE_MANDATE_DAILY_ENTRY_LIMIT/);checks++;
 await db.exec("update order_intents set state='unknown';update autopilot_workflows set max_daily_entries=10");
 await reject(insert('uncertain-capacity',1,{symbol:'ETH-USDC'}),'LIVE_MANDATE_POSITION_LIMIT');
 const occupied=(await db.query('select symbol from order_intents')).rows[0].symbol;
 await db.query('insert into positions values($1,$2,$3,$4,$5,$6,now(),now()+interval \'1 second\')',[owner,connection,occupied,'closed',plan,1]);
 await insert('reconciled-capacity',1,{symbol:occupied==='BTC-USDC'?'ETH-USDC':'BTC-USDC'});checks++;
 // Admission also retains the existing Aster/ApeX ceilings and five-rung behavior.
 for(const [venue,ceiling] of [['aster',125],['apex_omni',100]]){
   await reset();
   await db.query("update user_strategy set symbol='BTC-USDT',params=params || jsonb_build_object('leverage',$1::int)",[ceiling]);
   for(let rung=1;rung<=5;rung++)await insert(venue+'-campaign',rung,{venue,symbol:'BTC-USDT'});
   await reject(insert(venue+'-campaign',6,{venue,symbol:'BTC-USDT'}),'LIVE_MANDATE_CAMPAIGN_INVALID');
   await reset();
   await db.query("update user_strategy set params=params || jsonb_build_object('leverage',$1::int)",[ceiling+1]);
   await reject(insert(venue+'-ceiling',1,{venue,symbol:'BTC-USDT'}),'LIVE_MANDATE_LEVERAGE_REQUIRED');
 }
 console.log(`PASS: ${checks} database admission scenarios; SynFutures ownership, flags, 33x, five-rung capacity, schedule, losses, uncertain intents, serialized requests, exit exemption and existing venues`);
} finally {await db.close();}
