// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ attest: vi.fn(), rpc: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (data: unknown): unknown => data;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler: (fn: (args: unknown) => unknown) => (args: { data: unknown; context: unknown }) =>
        fn({ ...args, data: validate(args.data) }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("./registration.server", () => ({ attestSynFuturesAccount: mocks.attest }));
import { readSynFuturesRegistration, registerSynFuturesAccount } from "./registration.functions";
const walletId = "00000000-0000-4000-8000-000000000001";
const address = `0x${"1".repeat(40)}`;
const proof = {
  ownerAddress: address,
  safeAddress: `0x${"2".repeat(40)}`,
  moduleAddress: `0x${"3".repeat(40)}`,
  safeProxyCodeHash: "safe-hash",
  moduleCodeHash: "module-hash",
  blockNumber: "256",
  blockHash: "block-hash",
  blockTime: "2026-09-29T00:00:00.000Z",
};
const record = {
  id: "00000000-0000-4000-8000-000000000002",
  wallet_id: walletId,
  setup_revision: 2,
  chain_id: 8453,
  owner_address: address,
  safe_address: proof.safeAddress,
  module_address: proof.moduleAddress,
  status: "deployed_operator_pending",
  verified_at: proof.blockTime,
  execution_ready: false,
};
function context() {
  const wallet = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: { public_address: address }, error: null }),
  };
  const setup = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: { revision: 2 }, error: null }),
  };
  return {
    userId: "session-owner",
    wallet,
    setup,
    supabase: {
      rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
      from: vi.fn((table: string) => (table === "wallet_connections" ? wallet : setup)),
    },
  };
}
const run = registerSynFuturesAccount as unknown as (args: {
  data: unknown;
  context: ReturnType<typeof context>;
}) => Promise<unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.attest.mockResolvedValue(proof);
  mocks.rpc.mockResolvedValue({
    data: record,
    error: null,
  });
});
describe("SynFutures registration ownership boundary", () => {
  it.each([
    { execution_ready: true },
    { status: "live" },
    { setup_revision: 3 },
    { wallet_id: "00000000-0000-4000-8000-000000000099" },
    { safe_address: `0x${"4".repeat(40)}` },
    { owner_address: `0x${"4".repeat(40)}` },
    { module_address: `0x${"4".repeat(40)}` },
    { chain_id: 1 },
  ])("rejects inconsistent or live-looking persistence result %j", async (change) => {
    mocks.rpc.mockResolvedValue({ data: { ...record, ...change }, error: null });
    await expect(
      run({ data: { walletId, expectedRevision: 2 }, context: context() }),
    ).rejects.toThrow("could not be confirmed");
  });
  it("reads only authenticated-owner registration without observing or writing", async () => {
    const ctx = context();
    ctx.setup.maybeSingle.mockResolvedValue({ data: record, error: null } as never);
    const read = readSynFuturesRegistration as unknown as typeof run;
    expect(await read({ data: { walletId }, context: ctx })).toEqual(record);
    expect(ctx.supabase.from).toHaveBeenCalledWith("synfutures_account_registrations");
    expect(ctx.setup.eq.mock.calls).toEqual([
      ["user_id", ctx.userId],
      ["wallet_id", walletId],
    ]);
    expect(mocks.attest).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not turn read failure into an unregistered account", async () => {
    const ctx = context();
    ctx.setup.maybeSingle.mockResolvedValue({ data: null, error: {} });
    const read = readSynFuturesRegistration as unknown as typeof run;
    await expect(read({ data: { walletId }, context: ctx })).rejects.toThrow("status unavailable");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("persists only server-observed identity, authenticated owner and approved setup revision", async () => {
    const ctx = context();
    expect(await run({ data: { walletId, expectedRevision: 2 }, context: ctx })).toEqual(record);
    expect(ctx.wallet.eq.mock.calls).toEqual([
      ["id", walletId],
      ["user_id", ctx.userId],
      ["status", "verified"],
      ["is_active", true],
      ["chain", "ethereum"],
      ["network", "mainnet"],
    ]);
    expect(ctx.setup.eq.mock.calls).toEqual([
      ["user_id", ctx.userId],
      ["wallet_id", walletId],
    ]);
    expect(mocks.attest).toHaveBeenCalledWith(address, walletId);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("register_synfutures_account", {
      p_user_id: ctx.userId,
      p_wallet_id: walletId,
      p_setup_revision: 2,
      p_owner_address: address,
      p_safe_address: proof.safeAddress,
      p_module_address: proof.moduleAddress,
      p_safe_proxy_code_hash: proof.safeProxyCodeHash,
      p_module_code_hash: proof.moduleCodeHash,
      p_block_number: proof.blockNumber,
      p_block_hash: proof.blockHash,
      p_block_time: proof.blockTime,
    });
  });
  it.each(["notAdmin", "roleError", "walletMissing", "walletError", "staleSetup", "setupError"])(
    "does not observe chain or write for %s",
    async (kind) => {
      const ctx = context();
      if (kind === "notAdmin") ctx.supabase.rpc.mockResolvedValue({ data: false, error: null });
      if (kind === "roleError")
        ctx.supabase.rpc.mockResolvedValue({ data: true, error: {} } as never);
      if (kind === "walletMissing")
        ctx.wallet.maybeSingle.mockResolvedValue({ data: null, error: null });
      if (kind === "walletError")
        ctx.wallet.maybeSingle.mockResolvedValue({ data: null, error: {} });
      if (kind === "staleSetup")
        ctx.setup.maybeSingle.mockResolvedValue({ data: { revision: 3 }, error: null });
      if (kind === "setupError") ctx.setup.maybeSingle.mockResolvedValue({ data: null, error: {} });
      await expect(
        run({ data: { walletId, expectedRevision: 2 }, context: ctx }),
      ).rejects.toThrow();
      expect(mocks.attest).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );
  it.each(["userId", "safeAddress", "operator", "blockHash", "executionReady", "rpcUrl"])(
    "rejects caller-supplied %s",
    (field) => {
      expect(() =>
        run({ data: { walletId, expectedRevision: 2, [field]: "injected" }, context: context() }),
      ).toThrow();
      expect(mocks.attest).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );
  it("sanitizes observation errors and writes nothing after a failed proof", async () => {
    mocks.attest.mockRejectedValue(new Error("secret-rpc-token"));
    await expect(
      run({ data: { walletId, expectedRevision: 2 }, context: context() }),
    ).rejects.toThrow("account verification failed");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not report success after a database rejection", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "private-database-detail" } });
    await expect(
      run({ data: { walletId, expectedRevision: 2 }, context: context() }),
    ).rejects.toThrow("could not be confirmed");
  });
  it("sanitizes a thrown database transport error without retrying the write", async () => {
    mocks.rpc.mockRejectedValue(new Error("private-transport-token"));
    await expect(
      run({ data: { walletId, expectedRevision: 2 }, context: context() }),
    ).rejects.toThrow("could not be confirmed");
    expect(mocks.rpc).toHaveBeenCalledOnce();
  });
});
