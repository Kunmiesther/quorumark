import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

const source=await fs.readFile(new URL('../supabase/functions/worker-ingest/synfutures-ledger.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {handleSynFuturesLedger}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const user='00000000-0000-4000-8000-000000000001',connection='00000000-0000-4000-8000-000000000002';
const wallet='00000000-0000-4000-8000-000000000003';
const owner='0x'+'11'.repeat(20),safe='0x'+'22'.repeat(20),module='0x'+'33'.repeat(20);
function mock(overrides={}) {
 const calls=[];
 const data={exchange_connections:{id:connection,status:'verified',permission_trade:false,permissions_verified:false,is_live:false,
  permission_scopes:{registration_id:connection,wallet_id:wallet,owner_address:owner,safe_address:safe,module_address:module}},
  synfutures_account_registrations:{wallet_id:wallet,chain_id:8453,owner_address:owner,safe_address:safe,module_address:module,
  safe_proxy_code_hash:'0x'+'ab'.repeat(32),module_code_hash:'0x'+'cd'.repeat(32)},wallet_connections:{public_address:owner},...overrides};
 return {calls,from(table){
  calls.push(['from',table]);
  const query={select(columns){calls.push(['select',columns]);return query;},eq(key,value){calls.push(['eq',key,value]);return query;},
   in(key,value){calls.push(['in',key,value]);return query;},async maybeSingle(){return {data:data[table],error:null};}};
  return query;
 }};
}
async function run(admin,patch={}) {
 const r=await handleSynFuturesLedger(admin,{operation:'SYNFUTURES_ACCOUNT_CONTEXT',user_id:user,connection_id:connection,...patch});
 return {status:r.status,body:await r.json()};
}
let admin=mock(),result=await run(admin);
assert.equal(result.status,200); assert.equal(result.body.context.live_entry_allowed,false);
assert.equal(result.body.context.safe_address,safe);
assert.equal(admin.calls.filter(x=>x[0]==='eq'&&x[1]==='user_id'&&x[2]===user).length,3);
assert(admin.calls.some(x=>x[0]==='eq'&&x[1]==='is_active'&&x[2]===true));
assert.equal((await run(mock({exchange_connections:null}))).status,409);
assert.equal((await run(mock({wallet_connections:{public_address:'0x'+'ff'.repeat(20)}}))).status,409);
assert.equal((await run(mock({synfutures_account_registrations:null}))).status,409);
assert.equal((await run(mock(),{user_id:'invalid'})).status,400);
assert.equal((await run(mock(),{connection_id:'invalid'})).status,400);
console.log('SynFutures context: owner, venue, wallet revocation, binding and read-only authority checks passed');
