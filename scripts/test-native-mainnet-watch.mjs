import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
let source=await fs.readFile(new URL('../supabase/functions/worker-ingest/index.ts',import.meta.url),'utf8');
// Execute only the trusted read handler, with no Edge server or HTTP requests.
source=source.replace(/^import .*;$/gm,'')+'\nexport {handleConfigRead};\n';
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
globalThis.Deno={env:{get:()=>''},serve:()=>{}};
const {handleConfigRead}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
delete globalThis.Deno;
async function read(environment){
 const filters=[];
 const admin={from(table){
  const q={select(){return q;},eq(key,value){filters.push([table,key,value]);return q;},in(key,value){filters.push([table,key,value]);return q;},
   then(resolve){
    const data=table==='active_bot_config'?[]:[{id:'native-connection',user_id:'owner',exchange:'synfutures',environment:'mainnet',status:'verified',permission_read:true}];
    const values=filters.find(x=>x[0]===table&&x[1]==='environment')?.[2]??[];
    return Promise.resolve({data:data.filter(row=>values.includes(row.environment)),error:null}).then(resolve);
   }};return q;
 }};
 const response=await handleConfigRead(admin,'worker',environment,'correlation');
 return {body:await response.json(),filters};
}
for(const environment of ['mainnet','production']){
 const {body,filters}=await read(environment);
 assert.deepEqual(body.configs.map(x=>x.symbol),['BTC-USDC','ETH-USDC']);
 assert(body.configs.every(x=>x.scan_only===true&&x.permission_trade===false&&x.permissions_verified===false&&x.mode==='watch'&&x.cross_margin===true));
 assert.equal(filters.filter(x=>x[1]==='environment'&&x[2].includes('mainnet')&&x[2].includes('production')).length,2);
}
assert.equal((await read('testnet')).body.configs.length,0);
console.log('Native watch: production/mainnet aliases, USDC markets, cross margin, read-only authority and testnet isolation passed');
