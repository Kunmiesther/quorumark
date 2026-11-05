// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { inspectSynFuturesAccount, synAccountNote, type SynAccountReader } from "./account.server";

const owner = "0x1111111111111111111111111111111111111111";
const safe = "0x2222222222222222222222222222222222222222";
const module = "0x3333333333333333333333333333333333333333";
const operator = "0x4444444444444444444444444444444444444444";
const wallet = "00000000-0000-4000-8000-000000000001";
function reader(
  stage: "deployed" | "deploy_safe" | "deploy_module" = "deployed",
): SynAccountReader {
  return {
    chainId: vi.fn().mockResolvedValue(8453),
    deployment: vi
      .fn()
      .mockResolvedValue({
        owner,
        safe,
        module,
        chainId: 8453,
        stage,
        verifiedAtBlock: "9007199254740993",
      }),
    blockTime: vi.fn().mockResolvedValue(1_900_000_000n),
    marketLimits: vi.fn().mockResolvedValue([10n ** 18n, 1000n * 10n ** 18n, 5n * 10n ** 18n, 33]),
    operatorGas: vi.fn().mockResolvedValue(10n ** 15n),
    position: vi.fn().mockResolvedValue({ balance: 0n, size: 0n, entryNotional: 0n, entrySocialLossIndex: 0n, entryFundingIndex: 0n }),
    balances: vi.fn().mockResolvedValue([5_000_001n, 50_000_000n, 100_123_456n]),
    permissions: vi
      .fn()
      .mockResolvedValue([
        true,
        [operator, 2_000_000_000, 100n * 10n ** 18n, 25n * 10n ** 18n, 100],
      ]),
  };
}
describe("SynFutures trading-account readback", () => {
  it("reads real position units at the same verified block and preserves short exposure", async () => {
    const rpc = reader();
    vi.mocked(rpc.position).mockResolvedValue({ balance: 5n * 10n ** 18n, size: -(10n ** 17n), entryNotional: 100n * 10n ** 18n, entrySocialLossIndex: 0n, entryFundingIndex: 0n });
    const result = await inspectSynFuturesAccount(owner, wallet, rpc);
    expect(result.positions?.[0]).toMatchObject({ base_size_signed: "-0.1", balance_usdc: "5", entry_notional_usdc: "100", has_exposure: true });
    expect(rpc.position).toHaveBeenCalledWith(safe, expect.any(String), 9007199254740993n);
  });
  it("keeps incomplete position reads unknown instead of presenting a flat account", async () => {
    const rpc = reader();
    vi.mocked(rpc.position).mockRejectedValue(new Error("private RPC URL"));
    const result = await inspectSynFuturesAccount(owner, wallet, rpc);
    expect(result.positions).toBeNull();
    expect(JSON.stringify(result)).not.toContain("private RPC URL");
  });
  it("retains exit authority when entry budget is exhausted", async () => {
    const rpc = reader();
    vi.mocked(rpc.permissions).mockResolvedValue([true, [operator, 2_000_000_000, 100n * 10n ** 18n, 100n * 10n ** 18n, 100]]);
    const result = await inspectSynFuturesAccount(owner, wallet, rpc);
    expect(result.permissions?.session_authorized_at_block).toBe(false);
    expect(result.permissions?.exit_session_authorized_at_block).toBe(true);
    expect(result.readiness.blockers).not.toContain("EXIT_SESSION_UNAVAILABLE");
  });
  it("reports expired operator exit authority explicitly", async () => {
    const rpc = reader();
    vi.mocked(rpc.permissions).mockResolvedValue([true, [operator, 1_900_000_000, 100n * 10n ** 18n, 0n, 100]]);
    const result = await inspectSynFuturesAccount(owner, wallet, rpc);
    expect(result.permissions?.exit_session_authorized_at_block).toBe(false);
    expect(result.readiness.blockers).toContain("EXIT_SESSION_UNAVAILABLE");
  });
  it("reads market permissions and the operator's gas at the verified block without claiming execution", async () => {
    const rpc = reader();
    const result = await inspectSynFuturesAccount(owner, wallet, rpc);
    expect(rpc.marketLimits).toHaveBeenCalledTimes(2);
    expect(rpc.operatorGas).toHaveBeenCalledWith(operator, 9007199254740993n);
    expect(result.markets?.[0]).toMatchObject({ entries_enabled: true, max_margin_per_trade_usdc: "5", max_leverage: 33 });
    expect(result.readiness).toEqual({ execution_ready: false, blockers: ["AUTONOMOUS_EXECUTION_UNAVAILABLE", "PROTECTIVE_EXIT_UNAVAILABLE"] });
  });
  it("keeps failed market and gas observations unknown", async () => {
    const rpc = reader();
    vi.mocked(rpc.marketLimits).mockRejectedValue(new Error("rpc-secret"));
    vi.mocked(rpc.operatorGas).mockRejectedValue(new Error("rpc-secret"));
    const result = await inspectSynFuturesAccount(owner, wallet, rpc);
    expect(result.markets).toBeNull();
    expect(result.readiness.blockers).toContain("MARKET_LIMITS_UNVERIFIED");
    expect(result.readiness.blockers).toContain("OPERATOR_GAS_UNVERIFIED");
    expect(JSON.stringify(result)).not.toContain("rpc-secret");
  });
  it("reads the verified Safe, not its funding EOA, at the verified block with exact decimals", async () => {
    const rpc = reader();
    const result = await inspectSynFuturesAccount(owner, wallet, rpc);
    expect(rpc.deployment).toHaveBeenCalledWith(owner, wallet);
    expect(rpc.balances).toHaveBeenCalledWith(safe, 9007199254740993n);
    expect(rpc.permissions).toHaveBeenCalledWith(safe, module, 9007199254740993n);
    expect(rpc.blockTime).toHaveBeenCalledWith(9007199254740993n);
    expect(result).toMatchObject({
      execution_ready: false,
      balances: { usdc: "5.000001", gate_allowance_usdc: "50", gate_reserve_usdc: "100.123456" },
      permissions: {
        module_enabled: true,
        session_authorized_at_block: true,
        margin_budget_usdc: "100",
        margin_spent_usdc: "25",
      },
    });
    expect(synAccountNote(result)).toContain("excludes margin in positions");
    expect(synAccountNote(result)).toContain("does not activate trading");
  });
  it("does not label counterfactual balances as deployed collateral", async () => {
    const rpc = reader("deploy_safe");
    const result = await inspectSynFuturesAccount(owner, wallet, rpc);
    expect(result.balances).toBeNull();
    expect(result.permissions).toBeNull();
    expect(rpc.balances).not.toHaveBeenCalled();
    expect(rpc.permissions).not.toHaveBeenCalled();
    expect(synAccountNote(result)).toContain("is not deployed");
  });
  it("can read the deployed Safe before its module exists without fabricating permissions", async () => {
    const rpc = reader("deploy_module");
    const result = await inspectSynFuturesAccount(owner, wallet, rpc);
    expect(result.balances?.usdc).toBe("5.000001");
    expect(result.permissions).toBeNull();
    expect(rpc.permissions).not.toHaveBeenCalled();
    expect(synAccountNote(result)).toContain("module not deployed");
  });
  it.each([
    [false, operator, 2_000_000_000, 100n, 25n],
    [true, operator, 1_900_000_000, 100n, 25n],
    [true, "0x0000000000000000000000000000000000000000", 2_000_000_000, 100n, 25n],
    [true, operator, 2_000_000_000, 100n, 100n],
  ])(
    "never reports disabled, expired, revoked or exhausted sessions as authorized",
    async (enabled, address, expires, budget, spent) => {
      const rpc = reader();
      vi.mocked(rpc.permissions).mockResolvedValue([
        enabled as boolean,
        [address as typeof operator, expires as number, budget as bigint, spent as bigint, 100],
      ]);
      const result = await inspectSynFuturesAccount(owner, wallet, rpc);
      expect(result.permissions?.session_authorized_at_block).toBe(false);
      expect(result.execution_ready).toBe(false);
    },
  );
  it("retains unknowns and sanitizes errors instead of inventing zero collateral", async () => {
    const rpc = reader();
    vi.mocked(rpc.balances).mockRejectedValue(new Error("private-rpc-secret"));
    vi.mocked(rpc.permissions).mockRejectedValue(new Error("private-rpc-secret"));
    const result = await inspectSynFuturesAccount(owner, wallet, rpc);
    expect(result.balances).toBeNull();
    expect(result.permissions).toBeNull();
    expect(synAccountNote(result)).toContain("not assumed zero");
    expect(JSON.stringify(result)).not.toContain("private-rpc-secret");
  });
  it("zero balance is distinct from an unavailable balance", async () => {
    const rpc = reader();
    vi.mocked(rpc.balances).mockResolvedValue([0n, 0n, 0n]);
    expect((await inspectSynFuturesAccount(owner, wallet, rpc)).balances?.gate_reserve_usdc).toBe(
      "0",
    );
  });
  it("rejects malformed balances and session data", async () => {
    const rpc = reader();
    vi.mocked(rpc.balances).mockResolvedValue([-1n, 0n, 0n]);
    vi.mocked(rpc.permissions).mockResolvedValue([
      true,
      [operator, 2_000_000_000, 100n, 101n, 100],
    ]);
    const result = await inspectSynFuturesAccount(owner, wallet, rpc);
    expect(result.balances).toBeNull();
    expect(result.permissions).toBeNull();
  });
  it("does not read account state when deployment verification fails", async () => {
    const rpc = reader();
    vi.mocked(rpc.deployment).mockRejectedValue(new Error("ownership changed"));
    await expect(inspectSynFuturesAccount(owner, wallet, rpc)).rejects.toThrow();
    expect(rpc.balances).not.toHaveBeenCalled();
    expect(rpc.permissions).not.toHaveBeenCalled();
  });
  it("rejects a wrong-chain RPC before verifying or reading an account", async () => {
    const rpc = reader();
    vi.mocked(rpc.chainId).mockResolvedValue(1);
    await expect(inspectSynFuturesAccount(owner, wallet, rpc)).rejects.toThrow(
      "RPC_CHAIN_MISMATCH",
    );
    expect(rpc.deployment).not.toHaveBeenCalled();
  });
  it("never presents failed verification as a live route", () => {
    expect(synAccountNote(null)).toContain("verification unavailable");
  });
});
