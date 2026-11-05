// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ attest: vi.fn(), admin: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (data: unknown): unknown => data;
    const builder = { middleware: () => builder,
      inputValidator: (fn: typeof validate) => { validate = fn; return builder; },
      handler: (fn: (args: unknown) => unknown) => (args: { data: unknown; context: unknown }) =>
        fn({ ...args, data: validate(args.data) }),
    }; return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: m.admin } }));
vi.mock("./registration.server", () => ({ attestSynFuturesAccount: m.attest }));
import { connectSynFuturesAccount } from "./connection.functions";
const walletId = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const owner = "0x" + "1".repeat(40);
const safe = "0x" + "2".repeat(40);
const moduleAddress = "0x" + "3".repeat(40);
const proof = { ownerAddress: owner, safeAddress: safe, moduleAddress,
  safeProxyCodeHash: "safe-hash", moduleCodeHash: "module-hash",
  blockNumber: "256", blockHash: "block-hash", blockTime: "2026-10-03T00:00:00.000Z" };
const saved = { id, wallet_id: walletId, chain_id: 8453, owner_address: owner,
  safe_address: safe, module_address: moduleAddress,
  safe_proxy_code_hash: proof.safeProxyCodeHash, module_code_hash: proof.moduleCodeHash };
const row = { id, user_id: "session-user", exchange: "synfutures", environment: "mainnet",
  status: "verified", permission_read: true, permission_trade: false, permissions_verified: false,
  is_live: false, permission_scopes: { registration_id: id, wallet_id: walletId, safe_address: safe } };
function chain(data: unknown) {
  return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error: null }) };
}
function context() {
  const wallet = chain({ public_address: owner }); const registration = chain(saved);
  return { userId: "session-user", wallet, registration,
    supabase: { rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
      from: vi.fn((table: string) => table === "wallet_connections" ? wallet : registration) } };
}
const db = {
  upsert: vi.fn(), update: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn(), single: vi.fn(),
};
const run = connectSynFuturesAccount as unknown as (args: {
  data: unknown; context: ReturnType<typeof context>;
}) => Promise<unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  m.attest.mockResolvedValue(proof); m.admin.mockReturnValue(db);
  db.upsert.mockResolvedValue({ error: null });
  db.maybeSingle.mockResolvedValue({ data: row, error: null });
  db.single.mockResolvedValue({ data: row, error: null });
});
describe("SynFutures connection boundary", () => {
  it("saves a stable owned read-only connection after fresh Base attestation", async () => {
    const ctx = context();
    expect(await run({ data: { walletId }, context: ctx })).toEqual(row);
    expect(m.attest).toHaveBeenCalledWith(owner, walletId);
    expect(db.upsert).toHaveBeenCalledWith(expect.objectContaining({
      id, user_id: ctx.userId, exchange: "synfutures", environment: "mainnet",
      permission_read: true, permission_trade: false, permissions_verified: false, is_live: false,
      permission_scopes: expect.objectContaining({ wallet_id: walletId, registration_id: id,
        owner_address: owner, safe_address: safe, module_address: moduleAddress, read_only: true }),
    }), { onConflict: "id", ignoreDuplicates: true });
    expect(ctx.wallet.eq).toHaveBeenCalledWith("user_id", ctx.userId);
    expect(ctx.registration.eq).toHaveBeenCalledWith("user_id", ctx.userId);
  });
  it("uses the same ID for repeated connects instead of making duplicates", async () => {
    await run({ data: { walletId }, context: context() });
    await run({ data: { walletId }, context: context() });
    expect(db.upsert.mock.calls.map(call => call[0].id)).toEqual([id, id]);
  });
  it.each(["notAdmin", "walletMissing", "registrationMissing", "wrongOwner", "wrongChain"])(
    "rejects %s before observing or writing", async (kind) => {
      const ctx = context();
      if (kind === "notAdmin") ctx.supabase.rpc.mockResolvedValue({ data: false, error: null });
      if (kind === "walletMissing") ctx.wallet.maybeSingle.mockResolvedValue({ data: null, error: null });
      if (kind === "registrationMissing") ctx.registration.maybeSingle.mockResolvedValue({ data: null, error: null });
      if (kind === "wrongOwner") ctx.registration.maybeSingle.mockResolvedValue({ data: { ...saved, owner_address: safe }, error: null });
      if (kind === "wrongChain") ctx.registration.maybeSingle.mockResolvedValue({ data: { ...saved, chain_id: 1 }, error: null });
      await expect(run({ data: { walletId }, context: ctx })).rejects.toThrow();
      expect(m.attest).not.toHaveBeenCalled(); expect(m.admin).not.toHaveBeenCalled();
    });
  it.each(["safeAddress", "moduleAddress", "ownerAddress", "safeProxyCodeHash", "moduleCodeHash"])(
    "rejects changed proof %s before writing", async (field) => {
      m.attest.mockResolvedValue({ ...proof, [field]: "changed" });
      await expect(run({ data: { walletId }, context: context() })).rejects.toThrow("identity changed");
      expect(m.admin).not.toHaveBeenCalled();
    });
  it("sanitizes failed chain reads and makes no write", async () => {
    m.attest.mockRejectedValue(new Error("private-rpc-token"));
    await expect(run({ data: { walletId }, context: context() })).rejects.toThrow("Base account verification unavailable");
    expect(m.admin).not.toHaveBeenCalled();
  });
  it.each(["walletId", "safe_address", "is_live", "permission_trade"])(
    "does not overwrite a conflicting or live connection: %s", async (field) => {
      const changed = field === "walletId"
        ? { ...row, permission_scopes: { ...row.permission_scopes, wallet_id: "other" } }
        : field === "safe_address"
          ? { ...row, permission_scopes: { ...row.permission_scopes, safe_address: owner } }
          : { ...row, [field]: true };
      db.maybeSingle.mockResolvedValue({ data: changed, error: null });
      await expect(run({ data: { walletId }, context: context() })).rejects.toThrow("could not be confirmed");
      expect(db.update).not.toHaveBeenCalled();
    });
  it("refreshes a fully activated owned connection without changing its trading authority", async () => {
    const active = { ...row, is_live: true, permission_trade: true, permissions_verified: true,
      permission_scopes: { ...row.permission_scopes, read_only: false, operator_address: "0x" + "4".repeat(40) } };
    db.maybeSingle.mockResolvedValue({ data: active, error: null });
    db.single.mockResolvedValue({ data: active, error: null });
    expect(await run({ data: { walletId }, context: context() })).toEqual(active);
    expect(db.update).toHaveBeenCalledWith({ permission_read: true, last_verified_at: proof.blockTime,
      last_error: null, last_error_code: null, last_error_message: null });
  });
  it("does not report success after database persistence failure", async () => {
    db.single.mockResolvedValue({ data: null, error: { message: "private-detail" } });
    await expect(run({ data: { walletId }, context: context() })).rejects.toThrow("could not be confirmed");
  });
  it.each(["userId", "safeAddress", "permissionTrade", "rpcUrl"])("rejects injected %s", (field) => {
    expect(() => run({ data: { walletId, [field]: "injected" }, context: context() })).toThrow();
    expect(m.admin).not.toHaveBeenCalled();
  });
});

