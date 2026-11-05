import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const {PGlite}=process.argv[2]?await import(pathToFileURL(process.argv[2]).href):await import('@electric-sql/pglite');
const db=new PGlite();let n=0;
try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create table positions(id uuid primary key,user_id uuid,connection_id uuid,source text,status text,
      exchange text,pair text,side text,size numeric,entry_price numeric,pnl_amount numeric,
      opened_at timestamptz,updated_at timestamptz,strategy_metadata jsonb);
    create table trades(id uuid primary key);
    create table live_fills(id uuid primary key,user_id uuid,connection_id uuid,venue text,symbol text,
      side text,size numeric,price numeric,fill_ts timestamptz);
    create table apex_closed_pnl_observations(position_id uuid primary key,user_id uuid,connection_id uuid,evidence jsonb);
    grant usage on schema public to service_role;
    grant select,update on positions to service_role;grant select on live_fills,apex_closed_pnl_observations to service_role;
    create function stamp() returns trigger language plpgsql as $$ begin new.updated_at=now();return new;end;$$;
    create trigger positions_updated_at before update on positions for each row execute function stamp();`);
  await db.exec(await readFile(new URL('../supabase/migrations/20261016034806_reconcile_closed_position_pnl.sql',import.meta.url),'utf8'));
  const sql=await readFile(new URL('../supabase/migrations/20261016135224_reconcile_apex_reported_pnl.sql',import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql);
  async function fixture(){
    const i={p:randomUUID(),u:randomUUID(),c:randomUUID(),f:randomUUID()};
    const event={symbol:'BTC-USDT',size:'1',price:'100',exitPrice:'110',totalPnl:'8',createdAt:Date.parse('2026-01-01T02:00Z'),type:'CLOSE_POSITION',isLiquidate:false,isDeleverage:false};
    const history={status:'observed',begin:Date.parse('2026-01-01T00:55Z'),end:Date.parse('2026-01-01T02:02Z'),rows:[event]};
    await db.query(`insert into positions values($1,$2,$3,'live','closed','apex_omni','BTC-USDT','long',1,100,null,
      '2026-01-01T01:00Z','2026-01-01T02:01Z',$4)`,[i.p,i.u,i.c,JSON.stringify({origin:'venue_external',reconciliation:{at:'2026-01-01T01:59Z'},closure_evidence:{source:'venue_flat_snapshot',observed_at:'2026-01-01T02:01Z',realized_pnl_verified:false}})]);
    await db.query('insert into apex_closed_pnl_observations values($1,$2,$3,$4)',[i.p,i.u,i.c,JSON.stringify(history)]);
    await db.query(`insert into live_fills values($1,$2,$3,'apex_omni','BTC-USDT','SELL',1,110,'2026-01-01T02:00Z')`,[i.f,i.u,i.c]);
    return {...i,history};
  }
  const run=async(i,apply=false)=>(await db.query('select reconcile_apex_reported_pnl($1,$2,$3) result',[i.u,i.c,apply])).rows[0].result;
  const i=await fixture();assert.equal((await run(i)).results[0].status,'VERIFIED_DRY_RUN');n++;
  await db.exec('set role service_role');assert.equal((await run(i,true)).results[0].realized_pnl,8);await db.exec('reset role');
  const p=(await db.query('select * from positions where id=$1',[i.p])).rows[0];
  assert.equal(new Date(p.updated_at).toISOString(),'2026-01-01T02:01:00.000Z');
  assert.equal(p.strategy_metadata.realized_pnl_evidence.pnl_basis,'venue_reported_closing_pnl');
  assert.equal((await db.query('select fees_usd from live_position_pnl_settlements where position_id=$1',[i.p])).rows[0].fees_usd,null);
  assert.equal((await run(i,true)).results.length,0);n++;
  for(const [field,value] of [['symbol','ETH-USDT'],['size','2'],['price','101'],['exitPrice','111'],['totalPnl','NaN'],['isLiquidate',true],['isDeleverage',true],['type','FUNDING'],['createdAt',null]]){
    const j=await fixture();j.history.rows[0][field]=value;
    await db.query('update apex_closed_pnl_observations set evidence=$1 where position_id=$2',[JSON.stringify(j.history),j.p]);
    await run(j,true);assert.equal((await db.query('select pnl_amount from positions where id=$1',[j.p])).rows[0].pnl_amount,null);n++;
  }
  for(const [table,field,value] of [['live_fills','side','BUY'],['live_fills','venue','aster'],['live_fills','size','2'],['live_fills','user_id',randomUUID()],['apex_closed_pnl_observations','connection_id',randomUUID()]]){
    const j=await fixture();await db.query(`update ${table} set ${field}=$1 where ${table==='live_fills'?'id':'position_id'}=$2`,[value,table==='live_fills'?j.f:j.p]);
    await run(j,true);assert.equal((await db.query('select pnl_amount from positions where id=$1',[j.p])).rows[0].pnl_amount,null);n++;
  }
  const partial=await fixture();partial.history.rows.push({...partial.history.rows[0],createdAt:Date.parse('2026-01-01T01:30Z')});
  await db.query('update apex_closed_pnl_observations set evidence=$1 where position_id=$2',[JSON.stringify(partial.history),partial.p]);
  assert.equal((await run(partial,true)).results[0].status,'PARTIAL_OR_AMBIGUOUS_HISTORY');n++;
  const missing=await fixture();delete missing.history.begin;
  await db.query('update apex_closed_pnl_observations set evidence=$1 where position_id=$2',[JSON.stringify(missing.history),missing.p]);
  assert.equal((await run(missing,true)).results.length,0);n++;
  for(const pnl of ['0','-5']){
    const j=await fixture();j.history.rows[0].totalPnl=pnl;
    await db.query('update apex_closed_pnl_observations set evidence=$1 where position_id=$2',[JSON.stringify(j.history),j.p]);
    assert.equal((await run(j,true)).results[0].realized_pnl,Number(pnl));n++;
  }
  const short=await fixture();
  await db.query("update positions set side='short' where id=$1",[short.p]);
  await db.query("update live_fills set side='BUY' where id=$1",[short.f]);
  assert.equal((await run(short,true)).results[0].status,'SETTLED');n++;
  const overlap=await fixture();
  await db.query(`insert into positions select $1,user_id,connection_id,source,status,exchange,pair,'short',size,
    entry_price,0,opened_at,updated_at,strategy_metadata from positions where id=$2`,[randomUUID(),overlap.p]);
  assert.equal((await run(overlap,true)).results[0].status,'POSITION_OVERLAP');n++;
  for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(run(i),/permission denied/);await db.exec('reset role');n++;}
  console.log(`${n} venue-reported P&L checks passed (isolated PostgreSQL)`);
}finally{await db.close();}
