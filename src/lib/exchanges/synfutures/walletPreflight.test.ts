// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { synFuturesWalletPreflight, type WalletPreflightReader } from "./walletPreflight.server";
const address = "0x0000000000000000000000000000000000000001";
const token = "0x0000000000000000000000000000000000000002";
const probe = {
  chain_id: 8453,
  contracts_deployed: true,
  observer_read_compatible: true,
  markets: [0, 1].map(() => ({
    instrument: address as `0x${string}`,
    symbol: "BTC-USDC",
    quote_token: token as `0x${string}`,
    quote_decimals: 6,
    initial_margin_bps: 300,
    expiries: [4294967295],
  })),
};
function reader(): WalletPreflightReader {
  return {
    chainId: vi.fn().mockResolvedValue(8453),
    gas: vi.fn().mockResolvedValue(1000000000000000n),
    token: vi
      .fn()
      .mockResolvedValue({ symbol: "USDC", decimals: 6, balance: 12500000n, allowance: 0n }),
  };
}
describe("SynFutures owned-wallet preflight", () => {
  it("requires an owned verified mainnet EVM wallet at the server boundary", () => {
    const source = readFileSync("src/lib/exchanges/synfutures.functions.ts", "utf8");
    for (const predicate of [
      '.eq("user_id", userId)',
      '.eq("id", data.walletId)',
      '.eq("status", "verified")',
      '.eq("is_active", true)',
      '.eq("chain", "ethereum")',
      '.eq("network", "mainnet")',
    ])
      expect(source).toContain(predicate);
  });
  it("deduplicates registry quote tokens and reports raw wallet balances, not execution readiness", async () => {
    const rpc = reader();
    const result = await synFuturesWalletPreflight(address, probe, rpc);
    expect(result).toMatchObject({
      execution_ready: false,
      gas: { balance: "0.001", present: true },
      quotes: [{ symbol: "USDC", balance: "12.5", gate_allowance: "0", status: "read" }],
    });
    expect(rpc.token).toHaveBeenCalledTimes(1);
  });
  it("does not read tokens from an unverified registry", async () => {
    const rpc = reader();
    const result = await synFuturesWalletPreflight(
      address,
      { ...probe, observer_read_compatible: false },
      rpc,
    );
    expect(result.quotes).toEqual([]);
    expect(rpc.token).not.toHaveBeenCalled();
  });
  it("rejects the wrong chain before reading balances", async () => {
    const rpc = reader();
    vi.mocked(rpc.chainId).mockResolvedValue(1);
    await expect(synFuturesWalletPreflight(address, probe, rpc)).rejects.toThrow(
      "RPC_CHAIN_MISMATCH",
    );
    expect(rpc.gas).not.toHaveBeenCalled();
  });
  it("keeps failed reads unknown and does not leak provider errors", async () => {
    const rpc = reader();
    vi.mocked(rpc.gas).mockRejectedValue(new Error("private-url"));
    vi.mocked(rpc.token).mockRejectedValue(new Error("private-url"));
    const result = await synFuturesWalletPreflight(address, probe, rpc);
    expect(result.gas).toBeNull();
    expect(result.quotes[0].balance).toBeNull();
    expect(JSON.stringify(result)).not.toContain("private-url");
  });
  it("zero gas is a successful zero read, not an unavailable balance", async () => {
    const rpc = reader();
    vi.mocked(rpc.gas).mockResolvedValue(0n);
    expect((await synFuturesWalletPreflight(address, probe, rpc)).gas).toEqual({
      balance: "0",
      present: false,
    });
  });
  it("rejects an invalid address before RPC", async () => {
    const rpc = reader();
    await expect(synFuturesWalletPreflight("not-an-address", probe, rpc)).rejects.toThrow(
      "INVALID_WALLET_ADDRESS",
    );
    expect(rpc.chainId).not.toHaveBeenCalled();
  });
});
