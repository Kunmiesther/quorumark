import {readFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
const owner='00000000-0000-4000-8000-000000000001',stranger='00000000-0000-4000-8000-000000000002';
const plan='00000000-0000-4000-8000-000000000003',connection='00000000-0000-4000-8000-000000000004';
let checks=0;
const dir=new URL('../supabase/migrations/',import.meta.url);
const migration=process.argv[2]??new URL((await readdir(dir)).find(x=>x.endsWith('_synfutures_protected_campaign_lifecycle.sql')),dir);
const q=(sql,args=[])=>db.query(sql,args);
const reject=async(p,code)=>{await assert.rejects(p,new RegExp(code));checks++;};
try {
await db.exec(` create role anon;create role authenticated;create role service_role;
 create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql as $$select null::uuid$$;
 insert into auth.users values('${owner}'),('${stranger}');
 create type order_intent_state as enum ('signing','cancelled','failed','filled','submitted','reconciliation_required','unknown','expired','rejected');
 create type position_side as enum ('long','short');
 create table autopilot_workflows(id uuid primary key,user_id uuid,status text,proposal jsonb,updated_at timestamptz default now(),
   max_daily_entries int default 1,max_open_positions int default 1,schedule_enabled boolean default true,
   active_days smallint[] default '{0,1,2,3,4,5,6}',window_start time default '00:00',window_end time default '23:59:59',
   timezone text default 'UTC',loss_limit numeric default 25,approved_at timestamptz default now()-interval '1 day');
 create table exchange_connections(id uuid primary key,user_id uuid,unique(id,user_id),exchange text,environment text,status text,
   permission_trade boolean,permissions_verified boolean,is_live boolean,permission_read boolean default true);
 create table user_strategy(user_id uuid,connection_id uuid,symbol text,mode text,enabled boolean,params jsonb,updated_at timestamptz default now());
 create table bot_events(user_id uuid,level text,event text,detail jsonb);
 create table positions(id uuid primary key default gen_random_uuid(),exchange text,market_type text,side position_side,entry_price numeric,current_price numeric,size numeric,leverage numeric,pnl_pct numeric,status_dummy text,opened_at timestamptz,strategy_metadata jsonb default '{}'::jsonb,source text,venue_order_id text,unrealized_pnl numeric,mark_price numeric,user_id uuid,connection_id uuid,pair text,status text,autopilot_workflow_id uuid,pnl_amount numeric,updated_at timestamptz,synced_at timestamptz);
 create table order_intents(id uuid primary key default gen_random_uuid(),user_id uuid,connection_id uuid,client_order_id text,size numeric,state_reason text,exchange_order_id text,filled_size numeric,exchange_status text,last_reconciled_at timestamptz,
   environment text,venue text,symbol text,side text,order_type text,reduce_only boolean,state order_intent_state,
   automation_campaign_key text,autopilot_workflow_id uuid,created_at timestamptz default now(),unique(user_id,client_order_id));
 insert into autopilot_workflows(id,user_id,status,proposal) values('${plan}','${owner}','live_configured','{"setupBook":"live"}');
 insert into exchange_connections(id,user_id,exchange,environment,status,permission_trade,permissions_verified,is_live) values('${connection}','${owner}','synfutures','mainnet','verified',true,true,true);
 insert into user_strategy(user_id,connection_id,symbol,mode,enabled,params) values('${owner}','${connection}','BTC-USDC','live',true,'{"autopilot_workflow_id":"${plan}","leverage":33,"margin_usdc":"125","native_take_profit_bps":100,"native_locally_monitored_exits_accepted":true}'),
   ('${owner}','${connection}','ETH-USDC','live',true,'{"autopilot_workflow_id":"${plan}","leverage":33,"margin_usdc":"125","native_take_profit_bps":100,"native_locally_monitored_exits_accepted":true}');`);
for (const path of ['20261003233150_synfutures_campaign_admission.sql','20260927193803_synfutures_transaction_journal.sql'])
 await db.exec(await readFile(new URL('../supabase/migrations/'+path,import.meta.url),'utf8'));
await db.exec('create trigger admission before insert on order_intents for each row execute function validate_live_mandate_entry()');
await db.exec(await readFile(migration,'utf8'));
const nativePlan={version:1,symbol:'BTC-USDC',side:'BUY',leverage:33,margin_total:'125000000000000000000',margin_per_rung:'25000000000000000000',reference_mark:'100000000000000000000000',triggers:['99600000000000000000000','99500000000000000000000','99000000000000000000000','98500000000000000000000','98000000000000000000000'],stop_price:'97020000000000000000000',take_profit_bps:100,starting_balance:'0',start_block:'100'};
const create=(key='campaign-0001',p=nativePlan)=>q('select create_synfutures_campaign($1,$2,$3,$4,$5,$6) value',[owner,connection,key,p,'1','0.01']);
const created=(await create()).rows[0].value;assert.equal(created.created,true);checks++;
assert.equal((await create()).rows[0].value.created,false);assert.equal((await q('select count(*)::int n from synfutures_transactions')).rows[0].n,0);checks++;
const id=created.id,t1='00000000-0000-4000-8000-000000000010',t2='00000000-0000-4000-8000-000000000011';
const claim=(token=t1)=>q('select claim_synfutures_campaign($1,$2,$3,$4) value',[owner,connection,id,token]);
assert.equal((await claim()).rows[0].value,true);assert.equal((await claim(t2)).rows[0].value,false);checks++;
const prepare=(kind='entry',rung=1,token=t1)=>q('select prepare_synfutures_action($1,$2,$3,$4,$5,$6,$7,$8) value',[owner,connection,id,token,kind,rung,'0.01','SYNFUTURES_PULLBACK_TRIGGER']);
const finish=(status,token=t1)=>q('select finish_synfutures_campaign($1,$2,$3,$4,$5,$6)',[owner,connection,id,token,status,'SYNFUTURES_CANONICAL_FLAT']);
const operator='0x'+'11'.repeat(20),module='0x'+'22'.repeat(20),safe='0x'+'33'.repeat(20);
let nonce=1;
const tx=(reduce=false)=>({operator_address:operator,module_address:module,safe_address:safe,instrument_address:'0xec6c44e704eb1932ec5fe1e4aba58db6fee71460',operator_nonce:String(nonce),module_revision:'1',module_nonce:String(nonce),signed_size:reduce?'-10000000000000000':'10000000000000000',margin:reduce?'0':'25000000000000000000',reduce_only:reduce,tx_hash:'0x'+String(nonce++).padStart(64,'0')});
const reserve=(intent,t)=>q('select reserve_synfutures_transaction($1,$2,$3,$4) value',[owner,connection,intent,t]);
const observe=(intent,t,state='confirmed')=>q('select observe_synfutures_transaction($1,$2,$3,$4,$5,$6,$7)',[owner,connection,intent,t.tx_hash,state,state==='unknown'?null:101,state==='unknown'?null:'0x'+'ab'.repeat(32)]);
let first=(await prepare()).rows[0].value.intent_id,firstTx=tx();
await reserve(first,firstTx);assert.equal((await reserve(first,firstTx)).rows[0].value.created,false);checks++;
await reject(prepare('entry',2),'SYNFUTURES_TRANSACTION_IN_FLIGHT');
await reject(prepare('exit',0),'SYNFUTURES_TRANSACTION_IN_FLIGHT');
await q('select record_synfutures_provisional($1,$2,$3,$4,101,$5)',[owner,connection,first,firstTx.tx_hash,'0x'+'ab'.repeat(32)]);
await reject(prepare('entry',2),'SYNFUTURES_TRANSACTION_IN_FLIGHT');
const exit=(await prepare('exit',0)).rows[0].value.intent_id,exitTx=tx(true);await reserve(exit,exitTx);checks++;
await reject(prepare('exit',0),'SYNFUTURES_TRANSACTION_IN_FLIGHT');
await reject(finish('closed'),'SYNFUTURES_REALIZED_PNL_UNCONFIRMED');
await observe(first,firstTx);await observe(exit,exitTx,'reverted');
const retry=(await prepare('exit',0)).rows[0].value.intent_id;assert.notEqual(retry,exit);checks++;
const failed=await q('select fail_synfutures_action($1,$2,$3,$4,$5) value',[owner,connection,id,t1,retry]);assert.equal(failed.rows[0].value,true);checks++;
const abandoned=(await prepare('exit',0)).rows[0].value.intent_id;
await q("update synfutures_campaigns set lease_until=now()-interval '1 second' where id=$1",[id]);
assert.equal((await claim(t2)).rows[0].value,true);checks++;
await reject(reserve(abandoned,tx(true)),'SYNFUTURES_INTENT_MISMATCH');
assert.equal((await q('select state from synfutures_campaign_actions where intent_id=$1',[abandoned])).rows[0].state,'failed');checks++;
// A successful finalized reduction and exact verified accounting are required to close.
const finalIntent=(await prepare('exit',0,t2)).rows[0].value.intent_id,finalTx=tx(true);await reserve(finalIntent,finalTx);await observe(finalIntent,finalTx);
const proof={realized_pnl:'-26000000000000000000',receipt_block:'101',receipt_block_hash:'0x'+'ab'.repeat(32),closing_tx_hash:finalTx.tx_hash,entry_price:'100000000000000000000000',maximum_size:'10000000000000000',mark:'97000000000000000000000'};
await q('select settle_synfutures_campaign($1,$2,$3,$4,$5)',[owner,connection,id,t2,proof]);await finish('closed',t2);checks++;
await reject(create('campaign-0002'),'LIVE_MANDATE_LOSS_LIMIT');
await q('update positions set pnl_amount=1');
await q('update autopilot_workflows set max_daily_entries=10');
const second=(await create('campaign-0002')).rows[0].value;assert.equal(second.created,true);checks++;
await q("update positions set strategy_metadata='{}'");
await reject(create('campaign-0003',{...nativePlan,symbol:'ETH-USDC'}),'LIVE_MANDATE_PNL_UNCONFIRMED');
await q("update positions set strategy_metadata=jsonb_build_object('realized_pnl_verified',true)");
await q('update autopilot_workflows set max_open_positions=3,max_daily_entries=20');
// Drive all five rungs: no next rung after acceptance, exact finality advances.
const id2=second.id;
for (let rung=1;rung<=5;rung++) {
 await q('select claim_synfutures_campaign($1,$2,$3,$4)',[owner,connection,id2,t1]);
 const intent=(await q('select prepare_synfutures_action($1,$2,$3,$4,$5,$6,$7,$8) value',[owner,connection,id2,t1,'entry',rung,'0.01','SYNFUTURES_PULLBACK_TRIGGER'])).rows[0].value.intent_id;
 const t=tx();await reserve(intent,t);
 if (rung<5) await reject(q('select prepare_synfutures_action($1,$2,$3,$4,$5,$6,$7,$8)',[owner,connection,id2,t1,'entry',rung+1,'0.01','SYNFUTURES_PULLBACK_TRIGGER']),'SYNFUTURES_TRANSACTION_IN_FLIGHT');
 await observe(intent,t);checks++;
}
await reject(q('select prepare_synfutures_action($1,$2,$3,$4,$5,$6,$7,$8)',[owner,connection,id2,t1,'entry',6,'0.01','SYNFUTURES_PULLBACK_TRIGGER']),'SYNFUTURES_ACTION_INVALID');
// An owner edit cannot migrate an admitted campaign to another mandate.
await q("update user_strategy set params=params || jsonb_build_object('autopilot_workflow_id',$1::text) where symbol='BTC-USDC'",[stranger]);
await reject(q('select prepare_synfutures_action($1,$2,$3,$4,$5,$6,$7,$8)',[owner,connection,id2,t1,'entry',5,'0.01','SYNFUTURES_PULLBACK_TRIGGER']),'SYNFUTURES_CAMPAIGN_CONFIGURATION_MISMATCH');
await q("update user_strategy set params=params || jsonb_build_object('autopilot_workflow_id',$1::text) where symbol='BTC-USDC'",[plan]);
// Permission can be revoked after quote/preparation: reservation rechecks it.
const third=(await create('campaign-0003',{...nativePlan,symbol:'ETH-USDC'})).rows[0].value;
await q('select claim_synfutures_campaign($1,$2,$3,$4)',[owner,connection,third.id,t1]);
const pendingIntent=(await q('select prepare_synfutures_action($1,$2,$3,$4,$5,$6,$7,$8) value',[owner,connection,third.id,t1,'entry',1,'0.01','SYNFUTURES_PULLBACK_TRIGGER'])).rows[0].value.intent_id;
await q('update exchange_connections set permission_trade=false');
await reject(reserve(pendingIntent,{...tx(),instrument_address:'0x04d72fb4803b4e02f14971e5bd092375eb330749'}),'LIVE_MANDATE_NATIVE_PERMISSION_REQUIRED');
// All durable history survived retries and settlement.
assert.equal((await q('select count(*)::int n from synfutures_transactions')).rows[0].n,8);checks++;
assert.equal((await q("select count(*)::int n from synfutures_campaign_actions where state='failed'")).rows[0].n,3);checks++;
console.log(`PASS: ${checks} native lifecycle database scenarios; leases, exact replay, provisional reduction, uncertainty locks, retained failed retries, fenced restarts and verified PNL loss gates`);
} finally {await db.close();}
