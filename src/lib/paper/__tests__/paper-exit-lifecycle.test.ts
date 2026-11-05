/// <reference types="node" />
// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(resolve(process.cwd(),
  "supabase/migrations/20261003100033_repair_zen_paper_exit_lifecycle.sql"), "utf8");
const user = "00000000-0000-0000-0000-000000000001";
const position = "00000000-0000-0000-0000-000000000002";
const wallet = "00000000-0000-0000-0000-000000000003";
let db: PGlite;

const state = {
  entry_price: 100, size_qty: 1, size_notional: 100, margin: 10,
  entry_fee: 0.02, rung_count: 2, tp_level: 120, fills: [],
  pending_rungs: [], resize_levels: [], last_seen_candle_ts_ms: 1234,
  strategy_metadata: { contract_id: "zen_sweep_v1", first_target_taken: true, banked_net_pnl: 20 },
};
function trade(reason = "zen_tp1") {
  return {
    wallet_key: "long", symbol: "BTC-USDT", direction: "long",
    entry_price: 100, exit_price: 110, exit_reason: reason,
    size_qty: 0.5, size_notional: 50, margin: 5, leverage: 10,
    pnl_gross: 10.1, fees: 0.1, slippage_cost: 0, pnl_net: 10,
    hold_seconds: 60, opened_at: "2026-10-01T00:00:00Z",
    closed_at: "2026-10-01T00:01:00Z",
  };
}
function reduce(trades: unknown, nextState: unknown = state, expectedRungs = 2, owner = user) {
  return db.query<{ result: { trade_ids: string[] } }>(
    "select public.paper_reduce_position($1::uuid,$2::uuid,$3::integer,$4::jsonb,$5::jsonb,$6::numeric,$7::uuid,$8::jsonb) as result",
    [owner, position, expectedRungs, JSON.stringify(trades), JSON.stringify(nextState), 20, wallet,
      JSON.stringify({ trades_delta: 2, wins_delta: 2, losses_delta: 0 })],
  );
}
async function snapshot() {
  const [p, a, w, t] = await Promise.all([
    db.query<{ qty: number; strategy_metadata: typeof state.strategy_metadata }>("select size_qty::float8 as qty, strategy_metadata from paper_positions where id=$1", [position]),
    db.query<{ balance: number; pnl: number }>("select balance::float8 as balance, realized_pnl::float8 as pnl from paper_accounts"),
    db.query<{ trades_count: number; wins_count: number }>("select trades_count, wins_count from paper_wallets"),
    db.query<{ exit_reason: string }>("select exit_reason from paper_trades order by exit_reason"),
  ]);
  return { position: p.rows[0]!, account: a.rows[0]!, wallet: w.rows[0]!, trades: t.rows };
}

beforeAll(async () => {
  db = new PGlite();
  // Isolated PostgreSQL fixture: no network, credentials, or production rows.
  await db.exec(`
    create table paper_positions (
      id uuid primary key, user_id uuid, status text, rung_count integer,
      entry_price numeric, size_qty numeric, size_notional numeric, margin numeric,
      entry_fee numeric, tp_level numeric, fills jsonb, resize_levels jsonb,
      pending_rungs jsonb, strategy_metadata jsonb, last_seen_candle_ts_ms bigint
    );
    create table paper_trades (
      id uuid primary key default gen_random_uuid(), user_id uuid, wallet_key text,
      symbol text, direction text, entry_price numeric, exit_price numeric,
      exit_reason text constraint paper_trades_exit_reason_check check (exit_reason in ('stop','tp_touch')),
      size_qty numeric, size_notional numeric, margin numeric, leverage numeric,
      pnl_gross numeric, fees numeric, slippage_cost numeric, pnl_net numeric,
      hold_seconds integer, opened_at timestamptz, closed_at timestamptz, position_id uuid
    );
    create table paper_accounts (user_id uuid primary key, balance numeric, realized_pnl numeric, updated_at timestamptz);
    create table paper_wallets (id uuid primary key, user_id uuid, trades_count integer,
      wins_count integer, losses_count integer, last_tick_at timestamptz);
    create function public._paper_assert_owner(_user_id uuid) returns void language plpgsql as
      $$begin if _user_id <> current_setting('test.user_id')::uuid then raise exception 'paper_owner_mismatch'; end if; end$$;
  `);
  await db.query("select set_config('test.user_id',$1,false)", [user]);
  await db.exec(migration);
}, 30_000);
beforeEach(async () => {
  await db.exec("truncate paper_positions, paper_trades, paper_accounts, paper_wallets");
  await db.query("insert into paper_positions (id,user_id,status,rung_count,size_qty,strategy_metadata) values ($1,$2,'open',2,2,$3)",
    [position, user, JSON.stringify({ contract_id: "zen_sweep_v1", first_target_taken: false, banked_net_pnl: 0 })]);
  await db.query("insert into paper_accounts values ($1,1000,0,now())", [user]);
  await db.query("insert into paper_wallets values ($1,$2,0,0,0,now())", [wallet, user]);
});
afterAll(async () => { await db?.close(); });

describe("paper exit migration against isolated PostgreSQL", () => {
  it.each(["zen_tp1", "zen_tp2", "zen_trailing", "stop", "runner_breakeven_stop"])(
    "accepts the emitted exit reason %s and legacy single-trade callers", async (reason) => {
      const result = await reduce(trade(reason));
      expect(result.rows[0].result.trade_ids).toHaveLength(1);
      expect((await snapshot()).trades).toEqual([{ exit_reason: reason }]);
    });

  it("commits every lot, remaining size, target status and balances together", async () => {
    const result = await reduce([trade(), trade()]);
    expect(result.rows[0].result.trade_ids).toHaveLength(2);
    const after = await snapshot();
    expect(after.position).toEqual({ qty: 1, strategy_metadata: state.strategy_metadata });
    expect(after.account).toEqual({ balance: 1020, pnl: 20 });
    expect(after.wallet).toEqual({ trades_count: 2, wins_count: 2 });
    expect(after.trades).toHaveLength(2);
  });

  it("rolls back the first valid lot when a later lot is rejected", async () => {
    const before = await snapshot();
    await expect(reduce([trade(), trade("invalid_exit")])).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it("preserves existing metadata for legacy reductions without a metadata payload", async () => {
    const { strategy_metadata: _, ...legacyState } = state;
    await reduce(trade("tp_touch"), legacyState);
    expect((await snapshot()).position.strategy_metadata).toEqual({
      contract_id: "zen_sweep_v1", first_target_taken: false, banked_net_pnl: 0,
    });
  });

  it.each([
    { trades: [], next: state, rungs: 2, owner: user },
    { trades: [trade()], next: { ...state, strategy_metadata: null }, rungs: 2, owner: user },
    { trades: [trade()], next: state, rungs: 3, owner: user },
    { trades: [trade()], next: state, rungs: 2, owner: wallet },
  ])("rejects invalid payloads or authority without side effects", async ({ trades, next, rungs, owner }) => {
    const before = await snapshot();
    await expect(reduce(trades, next, rungs, owner)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it("repairs an unearned target flag without changing financial amounts", async () => {
    await db.query("update paper_positions set strategy_metadata=$1", [JSON.stringify({
      contract_id: "zen_sweep_v1", first_target_taken: true, banked_net_pnl: 0,
    })]);
    const before = await snapshot();
    await db.exec(migration);
    const after = await snapshot();
    expect(after.position.strategy_metadata.first_target_taken).toBe(false);
    expect(after.account).toEqual(before.account);
    expect(after.wallet).toEqual(before.wallet);
    expect(after.trades).toEqual(before.trades);
  });

  it("retains a target flag backed by a successful TP1 trade", async () => {
    await reduce([trade(), trade()]);
    const before = await snapshot();
    await db.exec(migration);
    expect(await snapshot()).toEqual(before);
  });
});
