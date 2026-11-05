// Disposable database proof. Never contacts a wallet, exchange, or production.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const owner = id(1), other = id(2), connection = id(3), intent = id(4);
const tx = {
  operator_address: `0x${'11'.repeat(20)}`, module_address: `0x${'22'.repeat(20)}`,
  safe_address: `0x${'33'.repeat(20)}`, instrument_address: '0x04d72fb4803b4e02f14971e5bd092375eb330749',
  operator_nonce: '6', module_revision: '3', module_nonce: '9007199254740993',
  signed_size: '-100000000000000000', margin: '0', reduce_only: true, tx_hash: `0x${'ab'.repeat(32)}`,
};
const reserve = (user = owner, iid = intent, t = tx) => db.query(
  'select reserve_synfutures_transaction($1,$2,$3,$4) result', [user, connection, iid, JSON.stringify(t)]);
const observe = (state, hash = tx.tx_hash, block = null, blockHash = null) => db.query(
  'select observe_synfutures_transaction($1,$2,$3,$4,$5,$6,$7)', [owner, connection, intent, hash, state, block, blockHash]);
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    insert into auth.users values('${owner}'),('${other}');
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;
    create table exchange_connections(id uuid primary key,user_id uuid,exchange text,environment text,unique(id,user_id));
    insert into exchange_connections values('${connection}','${owner}','synfutures','mainnet');
    create type order_intent_state as enum('signing','submitted','reconciliation_required','filled','failed');
    create table order_intents(id uuid primary key,user_id uuid,connection_id uuid,venue text,environment text,
      order_type text,symbol text,side text,size numeric,reduce_only boolean,state order_intent_state,
      exchange_order_id text,state_reason text,exchange_status text,filled_size numeric default 0,last_reconciled_at timestamptz);
    insert into order_intents(id,user_id,connection_id,venue,environment,order_type,symbol,side,size,reduce_only,state)
      values('${intent}','${owner}','${connection}','synfutures','mainnet','MARKET','ETH-USDC','SELL',0.1,true,'signing');
    grant select,insert,update on order_intents,exchange_connections to service_role;
  `);
  await db.exec(await readFile(new URL('../supabase/migrations/20260927193803_synfutures_transaction_journal.sql', import.meta.url), 'utf8'));
  await db.exec('set role service_role');
  await assert.rejects(reserve(other), /INTENT_NOT_FOUND/);
  for (const patch of [{signed_size:'100000000000000000'}, {reduce_only:false},
    {instrument_address:'0xec6c44e704eb1932ec5fe1e4aba58db6fee71460'}, {raw_transaction:'secret'}]) {
    await assert.rejects(reserve(owner,intent,{...tx,...patch}), /INTENT_MISMATCH|TRANSACTION_INVALID/);
  }
  for (const patch of [{margin:'1'}, {module_address:tx.safe_address}, {operator_nonce:'0.5'}, {tx_hash:'garbage'}]) {
    await assert.rejects(reserve(owner,intent,{...tx,...patch}), /check constraint/);
  }
  assert.equal((await reserve()).rows[0].result.created, true);
  assert.equal((await reserve()).rows[0].result.created, false);
  await assert.rejects(reserve(owner,intent,{...tx, tx_hash:`0x${'ef'.repeat(32)}`}), /REPLAY_MISMATCH/);
  const exact = await db.query('select list_synfutures_transactions($1,$2) result', [owner,connection]);
  assert.equal(exact.rows[0].result.module_nonce, '9007199254740993');
  assert.equal(exact.rows[0].result.signed_size, '-100000000000000000');
  assert.equal((await db.query('select list_synfutures_transactions($1,$2)',[other,connection])).rows.length, 0);
  const second = id(5);
  await db.exec(`insert into order_intents select '${second}',user_id,connection_id,venue,environment,order_type,symbol,side,size,reduce_only,'signing',null,null,null,0,null from order_intents where id='${intent}'`);
  await assert.rejects(reserve(owner,second,{...tx,operator_nonce:'7',module_nonce:'9007199254740994',tx_hash:`0x${'ef'.repeat(32)}`}), /synfutures_operator_inflight/);
  await observe('unknown');
  await assert.rejects(reserve(owner,second,{...tx,operator_nonce:'7',module_nonce:'9007199254740994',tx_hash:`0x${'ef'.repeat(32)}`}), /synfutures_operator_inflight/);
  await observe('broadcast');
  assert.equal((await db.query(`select state from order_intents where id='${intent}'`)).rows[0].state, 'submitted');
  await assert.rejects(observe('confirmed'), /OBSERVATION_INVALID/);
  await assert.rejects(observe('confirmed',`0x${'ee'.repeat(32)}`,256,`0x${'cd'.repeat(32)}`), /TRANSACTION_NOT_FOUND/);
  await observe('confirmed',tx.tx_hash,256,`0x${'cd'.repeat(32)}`);
  await observe('confirmed',tx.tx_hash,256,`0x${'cd'.repeat(32)}`);
  const filled = (await db.query(`select state,filled_size::text from order_intents where id='${intent}'`)).rows[0];
  assert.deepEqual(filled,{state:'filled',filled_size:'0.1'});
  await assert.rejects(observe('unknown'), /FINALITY_CONFLICT/);
  await assert.rejects(observe('reverted',tx.tx_hash,256,`0x${'cd'.repeat(32)}`), /FINALITY_CONFLICT/);
  await assert.rejects(reserve(owner,second,{...tx,operator_nonce:'6',module_nonce:'9007199254740994',tx_hash:`0x${'ef'.repeat(32)}`}), /unique constraint/);
  assert.equal((await reserve(owner,second,{...tx,operator_nonce:'7',module_nonce:'9007199254740994',tx_hash:`0x${'ef'.repeat(32)}`})).rows[0].result.created, true);
  await db.exec(`reset role;set role authenticated;set request.jwt.claim.sub='${owner}'`);
  assert.equal((await db.query('select * from synfutures_transactions')).rows.length, 2);
  await assert.rejects(reserve(), /permission denied/);
  await assert.rejects(observe('unknown'), /permission denied/);
  await assert.rejects(db.exec("update synfutures_transactions set state='unknown'"), /permission denied/);
  await db.exec(`set request.jwt.claim.sub='${other}'`);
  assert.equal((await db.query('select * from synfutures_transactions')).rows.length, 0);
  await db.exec('reset role;set role anon');
  await assert.rejects(db.query('select * from synfutures_transactions'), /permission denied/);
  console.log('PASS: durable reservation/replay, nonce isolation, exact uint256 JSON, unknown recovery, receipt identity, atomic finality, RLS and private writes.');
} finally { await db.close(); }
