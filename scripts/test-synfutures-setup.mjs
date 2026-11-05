// Disposable PostgreSQL verification; no external wallet, credentials or production writes.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const owner = '00000000-0000-0000-0000-000000000001';
const other = '00000000-0000-0000-0000-000000000002';
const wallet = '00000000-0000-0000-0000-000000000003';
const otherWallet = '00000000-0000-0000-0000-000000000004';
const insert = (user, id, amount = '100', leverage = '33') => `insert into synfutures_setup_drafts(user_id,wallet_id,allocation_usdc,max_leverage) values('${user}','${id}',${amount},${leverage})`;
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    insert into auth.users values('${owner}'),('${other}');
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated;
    create table wallet_connections(id uuid primary key,user_id uuid,status text,is_active boolean,chain text,network text);
    grant select,update on wallet_connections to service_role;
    insert into wallet_connections values('${wallet}','${owner}','verified',true,'ethereum','mainnet'),('${otherWallet}','${other}','verified',true,'ethereum','mainnet');
  `);
  await db.exec(await readFile(new URL('../supabase/migrations/20260927164603_synfutures_setup_drafts.sql', import.meta.url), 'utf8'));
  await db.exec('set role service_role');
  await assert.rejects(db.exec(insert(owner, otherWallet)), /synfutures_verified_wallet_required/);
  for (const amount of ['0', '-1', "'NaN'", "'Infinity'", '0.0000001']) {
    await assert.rejects(db.exec(insert(owner, wallet, amount)), /check constraint/);
  }
  await assert.rejects(db.exec(insert(owner, wallet, '100', '0')), /check constraint/);
  await db.exec(insert(owner, wallet));
  await db.exec(insert(other, otherWallet));
  assert.equal((await db.query(`select status from synfutures_setup_drafts where user_id='${owner}'`)).rows[0].status, 'draft');
  await assert.rejects(db.exec(`update synfutures_setup_drafts set status='live' where user_id='${owner}'`), /check constraint/);
  await assert.rejects(db.exec(`update synfutures_setup_drafts set user_id='${other}' where user_id='${owner}'`), /identity_immutable/);
  await db.exec(`update synfutures_setup_drafts set allocation_usdc=90 where user_id='${owner}' and revision=1`);
  assert.equal((await db.query(`update synfutures_setup_drafts set allocation_usdc=200 where user_id='${owner}' and revision=1 returning id`)).rows.length, 0);
  const row = (await db.query(`select allocation_usdc::text,revision from synfutures_setup_drafts where user_id='${owner}'`)).rows[0];
  assert.deepEqual(row, { allocation_usdc: '90', revision: 2 });
  for (const change of ["is_active=false", "status='pending'", "chain='solana'", "network='testnet'"]) {
    await db.exec(`begin; update wallet_connections set ${change} where id='${wallet}'`);
    await assert.rejects(db.exec(`update synfutures_setup_drafts set max_leverage=20 where user_id='${owner}'`), /verified_wallet_required/);
    await db.exec('rollback');
  }
  await db.exec(`reset role; set role authenticated; set request.jwt.claim.sub='${owner}'`);
  assert.equal((await db.query('select count(*)::int n from synfutures_setup_drafts')).rows[0].n, 1);
  assert.equal((await db.query(`select count(*)::int n from synfutures_setup_drafts where user_id='${other}'`)).rows[0].n, 0);
  await assert.rejects(db.exec(insert(owner, wallet)), /permission denied/);
  await assert.rejects(db.exec('update synfutures_setup_drafts set max_leverage=100'), /permission denied/);
  await assert.rejects(db.exec('delete from synfutures_setup_drafts'), /permission denied/);
  await db.exec('reset role; set role anon');
  await assert.rejects(db.exec('select * from synfutures_setup_drafts'), /permission denied/);
  await assert.rejects(db.exec(insert(owner, wallet)), /permission denied/);
  console.log('PASS: owner isolation, server-only writes, verified mainnet wallets, amount validation, stale-save protection, draft-only status.');
} finally { await db.close(); }
