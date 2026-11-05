// Disposable in-memory database. No real credentials, orders, or funds.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const {PGlite}=process.argv[2]?await import(pathToFileURL(process.argv[2]).href):await import('@electric-sql/pglite');
const db=new PGlite(); let checks=0;
try {
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create table positions(id uuid primary key);
    create type order_intent_state as enum('reconciliation_required','filled','cancelled','rejected');
    create table order_intents(id uuid primary key,user_id uuid,connection_id uuid,venue text,environment text,
      client_order_id text,symbol text,side text,order_type text,size numeric,reduce_only boolean,
      state order_intent_state,state_reason text,exchange_order_id text,exchange_status text,filled_size numeric,
      last_reconciled_at timestamptz,created_at timestamptz default now());
    grant usage on schema public to service_role;grant select,update on order_intents to service_role;`);
  const sql=await readFile(new URL('../supabase/migrations/20261016133753_reconcile_apex_order_evidence.sql',import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql);
  async function fixture(){
    const i={id:randomUUID(),u:randomUUID(),c:randomUUID()};
    await db.query(`insert into order_intents(id,user_id,connection_id,venue,environment,client_order_id,symbol,side,order_type,size,reduce_only,state,state_reason,filled_size)
      values($1,$2,$3,'apex_omni','mainnet','client1','BTC-USDT','BUY','LIMIT',1,false,'reconciliation_required','PROTECTION_UNCONFIRMED:STOP',0)`,[i.id,i.u,i.c]);return i;
  }
  const evidence=()=>({observed_at:new Date().toISOString(),symbol_flat:true,symbol_orders_empty:true,
    order:{id:'venue-1',client_order_id:'client1',symbol:'BTC-USDT',side:'BUY',order_type:'LIMIT',size:'1',filled_size:'1',status:'FILLED',reduce_only:false}});
  const run=async(i,e)=> (await db.query('select reconcile_apex_order_evidence($1,$2,$3,$4) result',[i.u,i.c,i.id,JSON.stringify(e)])).rows[0].result;
  const i=await fixture();await db.exec('set role service_role');
  assert.equal(await run(i,evidence()),'RESOLVED');assert.equal(await run(i,evidence()),'UNCHANGED');await db.exec('reset role');
  assert.equal((await db.query('select state from order_intents where id=$1',[i.id])).rows[0].state,'filled');
  const audit=(await db.query('select * from apex_order_recovery_audit where intent_id=$1',[i.id])).rows[0];
  assert.equal(audit.before_image.state_reason,'PROTECTION_UNCONFIRMED:STOP');checks++;
  const hashed=await fixture(),hashEvidence=evidence();
  await db.query('update order_intents set client_order_id=$1 where id=$2',
    ['tb1:e3ab35768a4bfabb991019929f2bdcca4a1b83693a5052f992b3da544408-r1',hashed.id]);
  hashEvidence.order.client_order_id='tb1e3ab309f23705d59c4b71c8da9c2f';
  assert.equal(await run(hashed,hashEvidence),'RESOLVED');checks++;
  for(const [key,value] of [['symbol_flat',false],['symbol_orders_empty',false],['order',null]]){
    const j=await fixture();assert.equal(await run(j,{...evidence(),[key]:value}),'UNRESOLVED');
    const row=(await db.query('select * from order_intents where id=$1',[j.id])).rows[0];
    assert.equal(row.state,'reconciliation_required');assert.equal(row.state_reason,'PROTECTION_UNCONFIRMED:STOP');assert.ok(row.last_reconciled_at);checks++;
  }
  for(const [key,value] of [['client_order_id','wrong'],['id',''],['symbol','ETH-USDT'],['side','SELL'],['order_type','MARKET'],
    ['reduce_only',true],['reduce_only',null],['size','2'],['filled_size','2'],['filled_size',null],['filled_size','NaN']]){
    const j=await fixture(),e=evidence();e.order[key]=value;
    await assert.rejects(run(j,e),/APEX_/);checks++;
  }
  for(const key of ['u','c']){const j=await fixture();j[key]=randomUUID();await assert.rejects(run(j,evidence()),/NOT_FOUND/);checks++;}
  for(const [col,value] of [['venue','aster'],['environment','testnet'],['exchange_order_id','other']]){
    const j=await fixture();await db.query(`update order_intents set ${col}=$1 where id=$2`,[value,j.id]);
    await assert.rejects(run(j,evidence()),/APEX_/);checks++;
  }
  const j=await fixture();await assert.rejects(run(j,{...evidence(),observed_at:'2020-01-01T00:00:00Z'}),/STALE/);checks++;
  for(const status of ['CANCELED','CANCELLED','EXPIRED','REJECTED']){
    const j=await fixture(),e=evidence();e.order.status=status;e.order.filled_size='0';
    assert.equal(await run(j,e),'RESOLVED');checks++;
  }
  for(const status of ['PENDING','UNKNOWN','OPEN']){
    const j=await fixture(),e=evidence();e.order.status=status;e.order.filled_size='0';
    assert.equal(await run(j,e),'UNRESOLVED');checks++;
  }
  for(const role of ['anon','authenticated']){
    await db.exec('set role '+role);await assert.rejects(run(j,evidence()),/permission denied/);await db.exec('reset role');checks++;
  }
  console.log(`${checks} ApeX recovery PostgreSQL checks passed`);
} finally{await db.close();}
