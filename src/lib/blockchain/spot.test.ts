// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData } from "viem";
import {
  compileSpotSwap,
  SPOT_ROUTES,
  ROUTER_ABI,
  spotAmounts,
  spotRequestSchema,
  type SpotRequest,
} from "./spot";
import { createSpotReader, previewSpotSwap, type SpotReader } from "./spot.server";
const owner = "0x1111111111111111111111111111111111111111" as const;
const walletId = "11111111-1111-4111-8111-111111111111";
const now = 1_790_400_000_000;
const request: SpotRequest = {
  network: "base",
  walletId,
  direction: "native_to_stable",
  amount: "0.01",
  slippageBps: 50,
};
const wallet = {
  id: walletId,
  chain: "ethereum",
  network: "mainnet",
  public_address: owner,
  status: "verified",
  is_active: true,
  provider: "metamask",
  label: null,
};
function reader(overrides: Partial<SpotReader> = {}): SpotReader {
  return {
    chainId: async () => 8453,
    block: async () => ({ number: 100n, timestamp: BigInt(now / 1000) }),
    code: async () => "0x6001",
    routerIdentity: async () => [SPOT_ROUTES.base.factory, SPOT_ROUTES.base.wrapped],
    decimals: async () => 6,
    symbol: async () => "USDC",
    pool: async () => "0x2222222222222222222222222222222222222222",
    quote: async (_a, _b, _amount, fee) => (fee === 500 ? 25_000_000n : 24_000_000n),
    nativeBalance: async () => 1_000_000_000_000_000_000n,
    tokenBalance: async () => 100_000_000n,
    allowance: async () => 100_000_000n,
    simulate: async () => 100_000n,
    gasPrice: async () => 1_000_000n,
    ...overrides,
  };
}
describe("spot swap validation and transaction compiler", () => {
  it("rejects arbitrary chains, addresses, extra fields and invalid slippage", () => {
    for (const patch of [
      { network: "solana" },
      { router: owner },
      { slippageBps: 0 },
      { slippageBps: 501 },
      { amount: "1e18" },
      { amount: "-1" },
    ])
      expect(spotRequestSchema.safeParse({ ...request, ...patch }).success).toBe(false);
  });
  it("uses chain-specific stable precision and rejects rounding", () => {
    expect(spotAmounts({ ...request, direction: "stable_to_native", amount: "1" }).raw).toBe(
      1_000_000n,
    );
    expect(
      spotAmounts({ ...request, network: "bnb", direction: "stable_to_native", amount: "1" }).raw,
    ).toBe(10n ** 18n);
    expect(() =>
      spotAmounts({ ...request, direction: "stable_to_native", amount: "1.0000001" }),
    ).toThrow(/decimal/);
    expect(() => spotAmounts({ ...request, amount: "0" })).toThrow(/positive/);
  });
  it("binds native input to the correct router, owner, slippage and deadline", () => {
    const compiled = compileSpotSwap(request, owner, 500, 25_000_000n, 123n);
    expect(compiled.transaction.to).toBe(SPOT_ROUTES.base.router);
    expect(compiled.transaction.value).toBe(10n ** 16n);
    expect(compiled.minimum).toBe(24_875_000n);
    const outer = decodeFunctionData({ abi: ROUTER_ABI, data: compiled.transaction.data });
    expect(outer.functionName).toBe("multicall");
    if (outer.functionName !== "multicall") throw new Error("wrong call");
    expect(outer.args[0]).toBe(123n);
    const swap = decodeFunctionData({ abi: ROUTER_ABI, data: outer.args[1][0] });
    if (swap.functionName !== "exactInputSingle") throw new Error("wrong swap");
    expect(swap.args[0].recipient.toLowerCase()).toBe(owner);
    expect(swap.args[0].amountIn).toBe(10n ** 16n);
    expect(swap.args[0].amountOutMinimum).toBe(compiled.minimum);
  });
  it("unwraps stable-to-native output only to the verified wallet", () => {
    const compiled = compileSpotSwap(
      { ...request, direction: "stable_to_native", amount: "10" },
      owner,
      500,
      10n ** 16n,
      123n,
    );
    expect(compiled.transaction.value).toBe(0n);
    const outer = decodeFunctionData({ abi: ROUTER_ABI, data: compiled.transaction.data });
    if (outer.functionName !== "multicall") throw new Error("wrong call");
    const unwrap = decodeFunctionData({ abi: ROUTER_ABI, data: outer.args[1][1] });
    expect(unwrap.functionName).toBe("unwrapWETH9");
    expect(unwrap.args).toEqual([compiled.minimum, owner]);
  });
});
describe("on-chain preflight", () => {
  it("chooses the highest direct pool output and simulates, never declares execution ready", async () => {
    const simulation = vi.fn(async () => 100_000n);
    const result = await previewSpotSwap(request, wallet, reader({ simulate: simulation }), now);
    expect(result.buyAmount).toBe("25");
    expect(result.minimumReceived).toBe("24.875");
    expect(result.feeBps).toBe(5);
    expect(result.simulation).toBe("passed");
    expect(result.executionReady).toBe(false);
    expect(simulation).toHaveBeenCalledTimes(1);
  });
  it.each([
    { chainId: async () => 1 },
    { code: async () => "0x" },
    { decimals: async () => 18 },
    { routerIdentity: async () => [owner, owner] as const },
    { block: async () => ({ number: 100n, timestamp: BigInt(now / 1000 - 121) }) },
  ])("rejects incorrect or stale network evidence", async (overrides) => {
    await expect(previewSpotSwap(request, wallet, reader(overrides), now)).rejects.toThrow();
  });
  it("rejects the wrong or unverified wallet", async () => {
    await expect(
      previewSpotSwap(request, { ...wallet, id: "another" }, reader(), now),
    ).rejects.toThrow(/wallet/i);
    await expect(
      previewSpotSwap(request, { ...wallet, status: "pending" }, reader(), now),
    ).rejects.toThrow(/wallet/i);
  });
  it("distinguishes missing funds from an RPC failure", async () => {
    const simulation = vi.fn();
    const result = await previewSpotSwap(
      request,
      wallet,
      reader({ nativeBalance: async () => 0n, simulate: simulation }),
      now,
    );
    expect(result.blockers).toContain("No ETH available for network fees.");
    expect(result.simulation).toBe("blocked");
    expect(simulation).not.toHaveBeenCalled();
    await expect(
      previewSpotSwap(
        request,
        wallet,
        reader({
          nativeBalance: async () => {
            throw new Error("RPC down");
          },
        }),
        now,
      ),
    ).rejects.toThrow("RPC down");
  });
  it("reports missing allowance without simulating or approving it", async () => {
    const simulation = vi.fn();
    const result = await previewSpotSwap(
      { ...request, direction: "stable_to_native", amount: "10" },
      wallet,
      reader({ allowance: async () => 0n, simulate: simulation }),
      now,
    );
    expect(result.blockers.join()).toMatch(/approval for exactly 10 USDC/);
    expect(simulation).not.toHaveBeenCalled();
  });
  it("reports simulation failures honestly", async () => {
    const result = await previewSpotSwap(
      request,
      wallet,
      reader({
        simulate: async () => {
          throw new Error("revert");
        },
      }),
      now,
    );
    expect(result.simulation).toBe("failed");
    expect(result.blockers.join()).toMatch(/simulation failed/);
  });
  it("does not treat the sell balance alone as enough for gas", async () => {
    const result = await previewSpotSwap(
      request,
      wallet,
      reader({ nativeBalance: async () => 10n ** 16n }),
      now,
    );
    expect(result.simulation).toBe("blocked");
    expect(result.blockers.join()).toMatch(/plus estimated execution gas/);
  });
  it("fails closed when no pool can be quoted", async () => {
    await expect(
      previewSpotSwap(
        request,
        wallet,
        reader({
          quote: async () => {
            throw new Error("no liquidity");
          },
        }),
        now,
      ),
    ).rejects.toThrow(/No quotable/);
  });
});

it.skipIf(process.env.RUN_PUBLIC_SPOT_CHECKS !== "1")(
  "verifies deployed Base and BNB routers and real quotes without transactions",
  async () => {
    for (const network of ["base", "bnb"] as const) {
      for (const direction of ["native_to_stable", "stable_to_native"] as const) {
        const publicReader = createSpotReader(network);
        const poolRead = publicReader.pool;
        const quoteRead = publicReader.quote;
        publicReader.pool = async (...args) => {
          try {
            return await poolRead(...args);
          } catch (error) {
            console.info(network, "pool read", (error as { details?: string }).details);
            throw error;
          }
        };
        publicReader.quote = async (...args) => {
          try {
            return await quoteRead(...args);
          } catch (error) {
            console.info(network, "quote read", (error as { details?: string }).details);
            throw error;
          }
        };
        const result = await previewSpotSwap(
          {
            ...request,
            network,
            direction,
            amount: direction === "native_to_stable" ? "0.001" : "1",
          },
          wallet,
          publicReader,
        );
        expect(Number(result.buyAmount)).toBeGreaterThan(0);
        expect(result.executionReady).toBe(false);
        console.info(
          JSON.stringify({
            network,
            direction,
            pool: result.pool,
            output: result.buyAmount,
            simulation: result.simulation,
            blockers: result.blockers,
          }),
        );
      }
    }
  },
  120_000,
);
