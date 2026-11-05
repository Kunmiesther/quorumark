// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { getPerpInfo } from "@synfutures/perpv3-ts";
import {
  probeSynFuturesSdk,
  SYNFUTURES_SDK_VERSION,
  type SynFuturesProbeReader,
} from "./probe.server";

const address = "0x0000000000000000000000000000000000000001" as const;
const info = getPerpInfo(8453);
function reader(): SynFuturesProbeReader {
  return {
    chainId: vi.fn().mockResolvedValue(8453),
    code: vi.fn().mockResolvedValue("0x1234"),
    instruments: vi.fn().mockResolvedValue([address]),
    expiries: vi.fn().mockResolvedValue([[4294967295]]),
    observerGate: vi.fn().mockResolvedValue(info.gate),
    observerSettings: vi.fn().mockResolvedValue([
      {
        symbol: "BTC-USDC",
        gate: info.gate,
        config: info.config,
        quote: address,
        decimals: 6,
        initialMarginRatio: 300,
      },
    ]),
  };
}
describe("SynFutures installed SDK compatibility", () => {
  it("pins the installed version and never equates reads with execution", async () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    expect(packageJson.dependencies["@synfutures/perpv3-ts"]).toBe(SYNFUTURES_SDK_VERSION);
    const result = await probeSynFuturesSdk(reader());
    expect(result).toMatchObject({
      reachable: true,
      contracts_deployed: true,
      instrument_count: 1,
      instruments_with_expiry: 1,
      observer_read_compatible: true,
      execution_ready: false,
    });
    expect(result.blockers).toEqual(["EXECUTION_ADAPTER_NOT_CONFIGURED"]);
  });
  it("stops before contract calls on a wrong network", async () => {
    const client = reader();
    client.chainId = vi.fn().mockResolvedValue(1);
    expect((await probeSynFuturesSdk(client)).blockers).toContain("RPC_CHAIN_MISMATCH");
    expect(client.code).not.toHaveBeenCalled();
  });
  it("does not count empty bytecode as a deployed contract", async () => {
    const client = reader();
    client.code = vi.fn().mockResolvedValue("0x");
    expect((await probeSynFuturesSdk(client)).blockers).toContain("SDK_CONTRACT_MISSING");
    expect(client.instruments).not.toHaveBeenCalled();
  });
  it("surfaces ABI incompatibility without leaking raw RPC errors", async () => {
    const client = reader();
    client.observerSettings = vi.fn().mockRejectedValue(new Error("private-rpc-secret"));
    const result = await probeSynFuturesSdk(client);
    expect(result.blockers).toContain("OBSERVER_READ_INCOMPATIBLE");
    expect(JSON.stringify(result)).not.toContain("private-rpc-secret");
  });
  it("keeps failed reads distinct from empty instruments", async () => {
    const client = reader();
    client.expiries = vi.fn().mockResolvedValue([null]);
    expect(await probeSynFuturesSdk(client)).toMatchObject({
      instrument_read_failures: 1,
      instruments_with_expiry: 0,
    });
    expect(client.observerSettings).not.toHaveBeenCalled();
  });
  it("keeps unread counts unknown when RPC fails", async () => {
    const client = reader();
    client.chainId = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await probeSynFuturesSdk(client)).toMatchObject({
      instrument_count: null,
      reachable: false,
    });
  });
  it("bounds scans when the registry grows", async () => {
    const client = reader();
    client.instruments = vi.fn().mockResolvedValue(Array(257).fill(address));
    expect((await probeSynFuturesSdk(client)).blockers).toContain("INSTRUMENT_SCAN_LIMIT");
    expect(client.expiries).not.toHaveBeenCalled();
  });
  it("rejects an observer pointing to another gate", async () => {
    const client = reader();
    client.observerGate = vi.fn().mockResolvedValue(address);
    expect((await probeSynFuturesSdk(client)).blockers).toContain("OBSERVER_GATE_MISMATCH");
    expect(client.instruments).not.toHaveBeenCalled();
  });
  it("does not publish a market belonging to another protocol", async () => {
    const client = reader();
    client.observerSettings = vi.fn().mockResolvedValue([
      {
        symbol: "BTC-USDC",
        gate: address,
        config: info.config,
        quote: address,
        decimals: 6,
        initialMarginRatio: 300,
      },
    ]);
    const result = await probeSynFuturesSdk(client);
    expect(result.markets).toEqual([]);
    expect(result.observer_read_compatible).toBe(false);
  });
});
