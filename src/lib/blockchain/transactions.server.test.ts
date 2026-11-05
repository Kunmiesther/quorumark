// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  TEST_ID,
  TEST_HASH,
  TEST_NOW,
  testPlan,
  testRecord,
  testRequest,
  testWallet,
} from "./transactions.fixtures";
import {
  claimSwapRecord,
  declineSwapRecord,
  listSwapRecords,
  prepareSwapRecord,
  trackSwapRecord,
} from "./transactions.server";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), prepare: vi.fn(), reconcile: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: mocks.admin } }));
vi.mock("./prepare.server", () => ({ prepareWalletSwap: mocks.prepare }));
vi.mock("@/lib/ai/committee/evaluate.server", () => ({ evaluateSnapshot: vi.fn() }));
vi.mock("./receipts.server", () => ({
  reconcileSwapReceipt: mocks.reconcile,
  createReceiptReader: () => ({}),
}));

// Small behavioral store: filters and compare-and-set updates actually execute.
// Both clients can see every row so tests cannot accidentally rely only on RLS.
type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
function query(table: string) {
  const filters: ((row: Row) => boolean)[] = [];
  let patch: Row | undefined;
  let addition: Row | undefined;
  const execute = (single = false) => {
    if (addition) {
      if (tables[table].some((row) => row.id === addition!.id))
        return { data: null, error: { code: "23505" } };
      tables[table].push({ ...testRecord(), ...addition });
      return { data: single ? tables[table].at(-1) : [tables[table].at(-1)], error: null };
    }
    const rows = tables[table].filter((row) => filters.every((f) => f(row)));
    if (patch) rows.forEach((row) => Object.assign(row, patch));
    return {
      data: single ? (rows[0] ? structuredClone(rows[0]) : null) : structuredClone(rows),
      error: null,
    };
  };
  const builder = {
    select: () => builder,
    order: () => builder,
    limit: () => builder,
    eq: (key: string, value: unknown) => {
      filters.push((row) => row[key] === value);
      return builder;
    },
    is: (key: string, value: unknown) => {
      filters.push((row) => row[key] === value);
      return builder;
    },
    update: (value: Row) => {
      patch = value;
      return builder;
    },
    insert: (value: Row) => {
      addition = value;
      return builder;
    },
    maybeSingle: async () => execute(true),
    single: async () => execute(true),
    then: (resolve: (value: ReturnType<typeof execute>) => unknown) =>
      Promise.resolve(execute()).then(resolve),
  };
  return builder;
}
const ctx = { userId: "owner", supabase: { from: query } as unknown as SupabaseClient };
afterEach(() => vi.useRealTimers());
const stored = () => tables.blockchain_swap_intents[0];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_NOW);
  vi.clearAllMocks();
  tables = {
    wallet_connections: [{ ...testWallet, user_id: "owner" }],
    blockchain_swap_intents: [
      { ...testRecord(), user_id: "owner", wallet_id: testWallet.id, network: "base" },
    ],
  };
  mocks.admin.mockImplementation(query);
  mocks.prepare.mockResolvedValue(testPlan());
  mocks.reconcile.mockResolvedValue({
    status: "submitted",
    receipt: null,
    transaction_nonce: null,
    hash_verified: false,
  });
});
describe("swap journal ownership and lifecycle", () => {
  it("rejects another user's claim, receipt and decline even with an admin writer", async () => {
    const foreign = { ...ctx, userId: "other" };
    await expect(claimSwapRecord(foreign, TEST_ID)).rejects.toThrow(/unavailable/);
    await expect(trackSwapRecord(foreign, TEST_ID, TEST_HASH)).rejects.toThrow(/unavailable/);
    stored().status = "signing";
    await expect(declineSwapRecord(foreign, TEST_ID)).rejects.toThrow(/Could not record/);
    expect(stored().status).toBe("signing");
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
  it("hands a draft to only one of two simultaneous claimers", async () => {
    const outcomes = await Promise.allSettled([
      claimSwapRecord(ctx, TEST_ID),
      claimSwapRecord(ctx, TEST_ID),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(stored().status).toBe("signing");
  });
  it("rechecks revoked wallets and expiry before handoff", async () => {
    tables.wallet_connections[0].is_active = false;
    await expect(claimSwapRecord(ctx, TEST_ID)).rejects.toThrow(/verified wallet/);
    tables.wallet_connections[0].is_active = true;
    vi.setSystemTime(TEST_NOW + 190_000);
    await expect(claimSwapRecord(ctx, TEST_ID)).rejects.toThrow(/expired/);
    expect(stored().status).toBe("prepared");
  });
  it("reuses an identical request ID without another model call, but rejects changed amounts", async () => {
    expect((await prepareSwapRecord(ctx, TEST_ID, testRequest)).id).toBe(TEST_ID);
    expect(mocks.prepare).not.toHaveBeenCalled();
    await expect(prepareSwapRecord(ctx, TEST_ID, { ...testRequest, amount: "1" })).rejects.toThrow(
      /different swap/,
    );
  });
  it("prepares only for an owned wallet and saves server-generated transaction details", async () => {
    tables.blockchain_swap_intents = [];
    await expect(
      prepareSwapRecord({ ...ctx, userId: "other" }, TEST_ID, testRequest),
    ).rejects.toThrow(/verified wallet/);
    const row = await prepareSwapRecord(ctx, TEST_ID, testRequest);
    expect(row.plan).toEqual(testPlan());
    expect(stored().user_id).toBe("owner");
    expect(stored().wallet_id).toBe(testWallet.id);
  });
  it("scopes the journal to owner, network and wallet", async () => {
    tables.blockchain_swap_intents.push(
      { ...stored(), id: "foreign", user_id: "other" },
      { ...stored(), id: "bnb", network: "bnb" },
      { ...stored(), id: "wallet2", wallet_id: "wallet2" },
    );
    expect((await listSwapRecords(ctx, testWallet.id, "base")).map((r) => r.id)).toEqual([TEST_ID]);
  });
  it("cannot track an unclaimed draft", async () => {
    await expect(trackSwapRecord(ctx, TEST_ID, TEST_HASH)).rejects.toThrow(/not handed/);
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
  it("preserves a reported hash if RPC fails, without manufacturing confirmation", async () => {
    stored().status = "signing";
    mocks.reconcile.mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(trackSwapRecord(ctx, TEST_ID, TEST_HASH)).rejects.toThrow(/RPC unavailable/);
    expect(stored()).toMatchObject({
      status: "submitted",
      tx_hash: TEST_HASH,
      hash_verified: false,
      receipt: null,
    });
  });
  it("keeps previous hashes when a verified replacement is tracked", async () => {
    stored().status = "submitted";
    stored().tx_hash = TEST_HASH;
    stored().transaction_nonce = "7";
    const replacement = `0x${"cd".repeat(32)}` as const;
    mocks.reconcile.mockResolvedValue({
      status: "confirmed",
      receipt: null,
      transaction_nonce: "7",
      hash_verified: true,
    });
    const row = await trackSwapRecord(ctx, TEST_ID, replacement);
    expect(row.tx_hash).toBe(replacement);
    expect(row.previous_hashes).toEqual([TEST_HASH]);
    expect(mocks.reconcile.mock.calls[0][3]).toBe("7");
    await expect(trackSwapRecord(ctx, TEST_ID, TEST_HASH)).rejects.toThrow(/already completed/);
  });
});
