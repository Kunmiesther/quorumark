// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  wallet: vi.fn(),
  account: vi.fn(),
  note: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (data: unknown) => unknown = (data) => data;
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
vi.mock("./probe.server", () => ({ cachedSynFuturesProbe: mocks.probe }));
vi.mock("./walletPreflight.server", () => ({ synFuturesWalletPreflight: mocks.wallet }));
vi.mock("./account.server", () => ({
  inspectSynFuturesAccount: mocks.account,
  synAccountNote: mocks.note,
}));
import { inspectSynFuturesWallet } from "../synfutures.functions";

const address = "0x1111111111111111111111111111111111111111";
const walletId = "00000000-0000-4000-8000-000000000001";
function context() {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: { public_address: address }, error: null }),
  };
  return {
    userId: "authenticated-owner",
    supabase: {
      rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
      from: vi.fn().mockReturnValue(query),
    },
    query,
  };
}
const run = inspectSynFuturesWallet as unknown as (args: {
  data: unknown;
  context: ReturnType<typeof context>;
}) => Promise<Record<string, unknown>>;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.probe.mockResolvedValue({ markets: [] });
  mocks.wallet.mockResolvedValue({ execution_ready: false, wallet_address: address });
  mocks.account.mockResolvedValue({ address: "derived-safe", execution_ready: false });
  mocks.note.mockReturnValue("Account verification result");
});
describe("SynFutures account endpoint ownership boundary", () => {
  it("uses the authenticated wallet's address and ID, not caller-supplied account data", async () => {
    const ctx = context();
    const result = await run({ data: { walletId }, context: ctx });
    expect(ctx.supabase.rpc).toHaveBeenCalledWith("has_role", {
      _user_id: ctx.userId,
      _role: "admin",
    });
    expect(ctx.query.eq.mock.calls).toEqual([
      ["id", walletId],
      ["user_id", ctx.userId],
      ["status", "verified"],
      ["is_active", true],
      ["chain", "ethereum"],
      ["network", "mainnet"],
    ]);
    expect(mocks.account).toHaveBeenCalledWith(address, walletId);
    expect(result.execution_ready).toBe(false);
    expect(result.trading_account).toEqual({ address: "derived-safe", execution_ready: false });
  });
  it.each([
    { data: false, error: null },
    { data: true, error: { message: "denied" } },
  ])("denies a failed admin authorization before reading any wallet or chain", async (response) => {
    const ctx = context();
    ctx.supabase.rpc.mockResolvedValue(response);
    await expect(run({ data: { walletId }, context: ctx })).rejects.toThrow(
      "OWNER_OR_ADMIN_REQUIRED",
    );
    expect(ctx.supabase.from).not.toHaveBeenCalled();
    expect(mocks.account).not.toHaveBeenCalled();
  });
  it("denies a missing, foreign, inactive or unverified owned-wallet query result", async () => {
    const ctx = context();
    ctx.query.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(run({ data: { walletId }, context: ctx })).rejects.toThrow(
      "VERIFIED_WALLET_REQUIRED",
    );
    expect(mocks.account).not.toHaveBeenCalled();
    expect(mocks.wallet).not.toHaveBeenCalled();
  });
  it("rejects caller-selected account and chain fields at input validation", async () => {
    const ctx = context();
    expect(() => run({ data: { walletId, safe: address, chainId: 1 }, context: ctx })).toThrow();
    expect(ctx.supabase.rpc).not.toHaveBeenCalled();
  });
  it("preserves wallet information when account verification is unavailable without leaking errors", async () => {
    mocks.account.mockRejectedValue(new Error("private-rpc-secret"));
    const result = await run({ data: { walletId }, context: context() });
    expect(result.trading_account).toBeNull();
    expect(result.wallet_address).toBe(address);
    expect(mocks.note).toHaveBeenCalledWith(null);
    expect(JSON.stringify(result)).not.toContain("private-rpc-secret");
  });
});
