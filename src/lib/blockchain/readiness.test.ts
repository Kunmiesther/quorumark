// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { BLOCKCHAINS, isSolanaAddress, walletSupportsNetwork, type NetworkWallet } from "./catalog";
import { inspectNetworkWallet } from "./readiness.server";

const wallet: NetworkWallet = {
  id: "wallet",
  chain: "ethereum",
  network: "mainnet",
  public_address: "0x0000000000000000000000000000000000000001",
  status: "verified",
  is_active: true,
  provider: "metamask",
  label: null,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("blockchain wallet reads", () => {
  it("uses the same configured Base endpoint for wallet readiness as execution", async () => {
    vi.stubEnv("TURTLEBOT_BASE_RPC_URL", "https://base.example/rpc");
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ id: 1, result: request.method === "eth_chainId" ? "0x2105" : "0x0" }),
        { headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetcher);
    expect((await inspectNetworkWallet(BLOCKCHAINS[0], wallet)).native_balance).toBe("0");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://base.example/rpc",
      "https://base.example/rpc",
    ]);
  });
  it("represents four networks without treating them as execution venues", () => {
    expect(BLOCKCHAINS.map((n) => n.id)).toEqual(["base", "solana", "robinhood", "bnb"]);
    expect(BLOCKCHAINS.find((n) => n.id === "robinhood")?.chainId).toBe(4663);
  });
  it("shares an EVM address but never infers a Solana address from MetaMask", () => {
    expect(BLOCKCHAINS.map((n) => walletSupportsNetwork(wallet, n))).toEqual([
      true,
      false,
      true,
      true,
    ]);
    for (const changes of [
      { status: "pending" },
      { is_active: false },
      { network: "testnet" },
      { public_address: "0x1234" },
    ])
      expect(walletSupportsNetwork({ ...wallet, ...changes }, BLOCKCHAINS[0])).toBe(false);
    expect(isSolanaAddress("11111111111111111111111111111111")).toBe(true);
    expect(isSolanaAddress("111111111111111111111111111111111")).toBe(false);
    expect(isSolanaAddress(wallet.public_address)).toBe(false);
  });
  it("verifies the chain before reading balance and formats native units", async () => {
    const rpc = vi.fn().mockResolvedValueOnce("0x2105").mockResolvedValueOnce("0xde0b6b3a7640000");
    expect(await inspectNetworkWallet(BLOCKCHAINS[0], wallet, rpc)).toMatchObject({
      native_balance: "1",
      gas_present: true,
      execution_ready: false,
      wallet_id: wallet.id,
    });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["eth_chainId", "eth_getBalance"]);
  });
  it("rejects a mismatched chain without a balance request", async () => {
    const rpc = vi.fn().mockResolvedValue("0x1");
    await expect(inspectNetworkWallet(BLOCKCHAINS[0], wallet, rpc)).rejects.toThrow(
      "NETWORK_MISMATCH",
    );
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("keeps zero balances distinct from failed reads", async () => {
    const rpc = vi.fn().mockResolvedValueOnce("0x2105").mockResolvedValueOnce("0x0");
    expect(await inspectNetworkWallet(BLOCKCHAINS[0], wallet, rpc)).toMatchObject({
      native_balance: "0",
      gas_present: false,
    });
    await expect(
      inspectNetworkWallet(BLOCKCHAINS[0], wallet, vi.fn().mockRejectedValue(new Error("offline"))),
    ).rejects.toThrow("offline");
  });
  it.each([null, "0x", -1, "-0x1"])("rejects malformed EVM balance %s", async (balance) => {
    const rpc = vi.fn().mockResolvedValueOnce("0x2105").mockResolvedValueOnce(balance);
    await expect(inspectNetworkWallet(BLOCKCHAINS[0], wallet, rpc)).rejects.toThrow(
      "INVALID_BALANCE",
    );
  });
  it("checks Solana mainnet genesis and lamport precision", async () => {
    const sol = { ...wallet, chain: "solana", public_address: "11111111111111111111111111111111" };
    const rpc = vi
      .fn()
      .mockResolvedValueOnce("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d")
      .mockResolvedValueOnce({ value: 1234567890 });
    expect(await inspectNetworkWallet(BLOCKCHAINS[1], sol, rpc)).toMatchObject({
      native_balance: "1.23456789",
      execution_ready: false,
    });
    await expect(
      inspectNetworkWallet(BLOCKCHAINS[1], sol, vi.fn().mockResolvedValue("devnet")),
    ).rejects.toThrow("NETWORK_MISMATCH");
  });
  it("requires authenticated ownership and accepts no caller RPC URL", () => {
    const source = readFileSync("src/lib/blockchain/readiness.functions.ts", "utf8");
    expect(source).toContain(".middleware([requireSupabaseAuth])");
    expect(source).toMatch(/\.eq\("user_id", userId\)\s*\.eq\("id", data.walletId\)/);
    expect(source).toMatch(/\.strict\(\)\s*\.parse\(input\)/);
    expect(source).not.toContain("data.rpc");
  });
});
