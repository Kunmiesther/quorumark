// Isolated in-memory PostgreSQL only. No production connection or credentials.
// Usage: node scripts/test-closed-position-pnl.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const { PGlite } = process.argv[2]
  ? await import(pathToFileURL(process.argv[2]).href)
  : await import('@electric-sql/pglite');

const db = new PGlite();
let tests = 0;
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table positions(id uuid primary key,user_id uuid,connection_id uuid,source text,status text,
      exchange text,pair text,side text,size numeric,entry_price numeric,pnl_amount numeric,
      opened_at timestamptz,updated_at timestamptz,strategy_metadata jsonb);
    create table trades(id uuid primary key,user_id uuid,connection_id uuid,exchange text,book text,
      pair text,side text,size numeric,entry_price numeric,exit_price numeric,realized_pnl numeric,fees_usd numeric,
      opened_at timestamptz,closed_at timestamptz,evidence_verified boolean,evidence_source text,
      entry_venue_fill_id text,exit_venue_fill_id text);
    create table live_fills(id uuid primary key,user_id uuid,connection_id uuid,venue text,symbol text,
      side text,size numeric,price numeric,fee numeric,fee_currency text,venue_fill_id text,fill_ts timestamptz);
    create function update_updated_at_column() returns trigger language plpgsql as $$
      begin new.updated_at=now(); return new; end; $$;
    create trigger positions_updated_at before update on positions for each row execute function update_updated_at_column();
    grant usage on schema public to service_role;
    grant select,update on positions to service_role;
    grant select,update on trades,live_fills to service_role;
  `);
  const migration = await readFile(new URL('../supabase/migrations/20261016034806_reconcile_closed_position_pnl.sql',import.meta.url),'utf8');
  await db.exec(migration);
  await db.exec(migration);
  async function fixture({venue='aster',short=false,exit=110}={}) {
    const ids={user:randomUUID(),conn:randomUUID(),position:randomUUID(),trade:randomUUID(),entry:randomUUID(),exit:randomUUID()};
    const side=short?'short':'long', buy=short?'SELL':'BUY', sell=short?'BUY':'SELL';
    const pnl=(exit-100)*(short?-1:1)-2;
    await db.query(`insert into positions values($1,$2,$3,'live','closed',$4,'ETH-USDT',$5,1,100,null,
      '2026-01-01T01:01Z','2026-01-01T02:01Z',$6)`,[ids.position,ids.user,ids.conn,venue,side,JSON.stringify({origin:'turtlebot',
      reconciliation:{at:'2026-01-01T01:59:00Z'},closure_evidence:{source:'venue_flat_snapshot',observed_at:'2026-01-01T02:01:00Z',realized_pnl_verified:false}})]);
    await db.query(`insert into trades values($1,$2,$3,$4,'live','ETH-USDT',$5,1,100,$6,$7,2,
      '2026-01-01T01:00Z','2026-01-01T02:00Z',true,'venue_fill_reconciliation','entry','exit')`,[ids.trade,ids.user,ids.conn,venue,side,exit,pnl]);
    await db.query(`insert into live_fills values
      ($1,$3,$4,$5,'ETH-USDT',$6,1,100,1,'USDT','entry','2026-01-01T01:00Z'),
      ($2,$3,$4,$5,'ETH-USDT',$7,1,$8,1,'USDT','exit','2026-01-01T02:00Z')`,[ids.entry,ids.exit,ids.user,ids.conn,venue,buy,sell,exit]);
    return {...ids,pnl};
  }
  async function run(i,apply=false) {
    return (await db.query('select reconcile_closed_position_pnl($1,$2,$3) result',[i.user,i.conn,apply])).rows[0].result;
  }
  const i=await fixture();
  assert.equal((await run(i)).results[0].status,'VERIFIED_DRY_RUN');
  assert.equal((await db.query('select count(*) n from live_position_pnl_settlements')).rows[0].n,0); tests++;
  await db.exec('set role service_role');
  assert.equal((await run(i,true)).results[0].realized_pnl,8);
  await db.exec('reset role');
  const settled=(await db.query('select * from positions where id=$1',[i.position])).rows[0];
  assert.equal(Number(settled.pnl_amount),8);
  assert.equal(new Date(settled.updated_at).toISOString(),'2026-01-01T02:01:00.000Z');
  assert.equal(settled.strategy_metadata.origin,'turtlebot');
  assert.equal(settled.strategy_metadata.closure_evidence.realized_pnl_verified,true);
  assert.equal((await run(i,true)).results.length,0); tests++;
  for (const options of [{venue:'apex_omni'},{short:true,exit:90},{exit:102},{exit:90}]) {
    const x=await fixture(options);
    assert.equal((await run(x,true)).results[0].realized_pnl,x.pnl); tests++;
  }
  const checks=[
    ['update trades set size=0.5 where id=$1','trade','POSITION_TRADE_MISMATCH'],
    ['update trades set entry_price=99 where id=$1','trade','POSITION_TRADE_MISMATCH'],
    ['update trades set realized_pnl=null where id=$1','trade','TRADE_EVIDENCE_INCOMPLETE'],
    ["update trades set realized_pnl='NaN' where id=$1",'trade','TRADE_EVIDENCE_INCOMPLETE'],
    ['update trades set evidence_verified=false where id=$1','trade','TRADE_EVIDENCE_INCOMPLETE'],
    ["update trades set entry_venue_fill_id='missing' where id=$1",'trade','ENTRY_FILL_MISMATCH'],
    ["update trades set exit_venue_fill_id='missing' where id=$1",'trade','EXIT_FILL_MISMATCH'],
    ["update live_fills set fee_currency='BNB' where id=$1",'exit','FILL_ACCOUNTING_INCOMPLETE'],
    ['update live_fills set fee=3 where id=$1','exit','FILL_TOTAL_MISMATCH'],
    ['update live_fills set size=0.5 where id=$1','entry','FILL_TOTAL_MISMATCH'],
    ["update live_fills set user_id='00000000-0000-0000-0000-000000000001' where id=$1",'exit','FILL_TOTAL_MISMATCH'],
    ["update trades set exchange='other' where id=$1",'trade','POSITION_TRADE_MISMATCH'],
    ["update trades set book='paper' where id=$1",'trade','POSITION_TRADE_MISMATCH'],
  ];
  for (const [sql,key,status] of checks) {
    const x=await fixture(); await db.query(sql,[x[key]]);
    assert.equal((await run(x,true)).results[0].status,status,sql);
    assert.equal((await db.query('select pnl_amount from positions where id=$1',[x.position])).rows[0].pnl_amount,null); tests++;
  }
  const apex=await fixture({venue:'apex_omni'});
  await db.query('update live_fills set fee_currency=null where connection_id=$1',[apex.conn]);
  assert.equal((await run(apex)).results[0].status,'VERIFIED_DRY_RUN'); tests++;
  const overlap=await fixture();
  await db.query(`insert into positions select $1,user_id,connection_id,source,'open',exchange,pair,side,size,
    entry_price,pnl_amount,opened_at,updated_at,strategy_metadata from positions where id=$2`,[randomUUID(),overlap.position]);
  assert.equal((await run(overlap)).results[0].status,'OVERLAPPING_POSITION'); tests++;
  const wrong=await fixture();
  assert.equal((await run({...wrong,user:randomUUID()})).results.length,0); tests++;
  const late=await fixture();
  // A later fill read can complete the accounting without resetting any cursor.
  await db.query("update live_fills set symbol='OTHER-USDT' where id=$1",[late.exit]);
  assert.equal((await run(late,true)).results[0].status,'FILL_TOTAL_MISMATCH');
  await db.query("update live_fills set symbol='ETH-USDT' where id=$1",[late.exit]);
  assert.equal((await run(late,true)).results[0].status,'SETTLED'); tests++;
  const partial=await fixture();
  await db.query("update trades set closed_at='2026-01-01T01:58Z' where id=$1",[partial.trade]);
  assert.equal((await run(partial)).results[0].status,'POSITION_TIME_MISMATCH'); tests++;
  const split=await fixture();
  await db.query('update trades set size=0.4,realized_pnl=3.2,fees_usd=0.8 where id=$1',[split.trade]);
  await db.query(`insert into trades select $1,user_id,connection_id,exchange,book,pair,side,
    0.6,entry_price,exit_price,4.8,1.2,'2026-01-01T01:30Z',closed_at,evidence_verified,evidence_source,'entry2','exit2'
    from trades where id=$2`,[randomUUID(),split.trade]);
  await db.query('update live_fills set size=0.4,fee=0.4 where connection_id=$1',[split.conn]);
  await db.query(`insert into live_fills select $1,user_id,connection_id,venue,symbol,side,
    0.6,price,0.6,fee_currency,'entry2','2026-01-01T01:30Z' from live_fills where id=$2`,[randomUUID(),split.entry]);
  await db.query(`insert into live_fills select $1,user_id,connection_id,venue,symbol,side,
    0.6,price,0.6,fee_currency,'exit2',fill_ts from live_fills where id=$2`,[randomUUID(),split.exit]);
  assert.equal((await run(split,true)).results[0].realized_pnl,8); tests++;
  const paper=await fixture();
  await db.query("update positions set source='paper' where id=$1",[paper.position]);
  assert.equal((await run(paper,true)).results.length,0); tests++;
  await db.exec('set role authenticated');
  await assert.rejects(()=>run(wrong,true),/permission denied/); tests++;
  await db.exec('reset role');
  assert.equal((await db.query(`select has_function_privilege('anon',
    'public.reconcile_closed_position_pnl(uuid,uuid,boolean)','execute') permitted`)).rows[0].permitted,false); tests++;
  console.log(`${tests} closed-position accounting checks passed (isolated PostgreSQL).`);
} finally { await db.close(); }
