import { describe, it, expect } from "vitest";
import { bydfiAdapter } from "../adapters/bydfi";
import { unverifiedAdapter } from "../adapters/unverified";
import { getUniverseAdapter } from "../adapters/registry";
import { normalizeApexContract, normalizeApexUniverse } from "../adapters/apex";
import { buildPaperUniverse } from "../adapters/paper";

describe("adapter fail-closed contracts", () => {
  it("BYDFi returns unverified empty universe before any handshake completes", async () => {
    const u = await bydfiAdapter.discover({ environment: "paper", marketType: "futures", now: 1 });
    expect(u.health).toBe("unverified");
    expect(u.instruments).toEqual([]);
    // Adapter is now v1 (handshake landed); no verified rows in test DB → empty.
    expect(u.adapterVersion).toBe(1);
    expect(["no_verified_connection", "adapter_query_failed"]).toContain(u.detail.reason);
  });

  it("Unknown exchange resolves to explicit unverified adapter", async () => {
    const adapter = getUniverseAdapter("someRandomExchange");
    expect(adapter.adapterVersion).toBe(0);
    const u = await adapter.discover({ environment: "paper", marketType: "futures", now: 1 });
    expect(u.health).toBe("unverified");
    expect(u.instruments).toEqual([]);
  });

  it("Unverified adapter always returns empty instruments", async () => {
    const adapter = unverifiedAdapter("mystery");
    const u = await adapter.discover({ environment: "paper", marketType: "futures", now: 1 });
    expect(u.exchange).toBe("mystery");
    expect(u.instruments).toEqual([]);
  });

  it("ApeX normalizer handles missing numeric fields as null (fail-closed downstream)", () => {
    const inst = normalizeApexContract(
      { symbolDisplayName: "BTCUSDT", enableTrade: true, enableDisplay: true },
      Date.now(),
    );
    expect(inst).not.toBeNull();
    expect(inst!.symbol).toBe("BTC-USDT");
    expect(inst!.maxLeverage).toBeNull();
    expect(inst!.tickSize).toBeNull();
    expect(inst!.minNotional).toBeNull();
  });

  it("ApeX normalizer skips rows with no symbol", () => {
    expect(normalizeApexContract({}, Date.now())).toBeNull();
  });

  it("ApeX normalizer computes usable numbers from string fields", () => {
    const inst = normalizeApexContract(
      {
        symbolDisplayName: "ETHUSDT",
        enableTrade: true,
        enableDisplay: true,
        maxLeverage: "50",
        tickSize: "0.01",
        minOrderSize: "0.001",
        minNotional: "5",
        turnover24h: "12500000",
        bid: "3000",
        ask: "3001",
      },
      Date.now(),
    );
    expect(inst).not.toBeNull();
    expect(inst!.maxLeverage).toBe(50);
    expect(inst!.tickSize).toBe(0.01);
    expect(inst!.minNotional).toBe(5);
    expect(inst!.volume24hUsd).toBe(12_500_000);
    expect(inst!.spreadBps).toBeGreaterThan(0);
    expect(inst!.spreadBps).toBeLessThan(10);
  });

  it("ApeX universe normalizer deduplicates and flags offline on empty", () => {
    const u = normalizeApexUniverse({ data: { contractConfig: { perpetualContract: [] } } }, "paper", "futures", 1);
    expect(u.health).toBe("offline");
    expect(u.instruments).toEqual([]);
  });

  it("Paper adapter converts seeds to a healthy verified universe", () => {
    const u = buildPaperUniverse(
      [
        { symbol: "BTC-USDT", enabled: true, max_leverage: 100, market_available: true },
        { symbol: "ETH-USDT", enabled: true, max_leverage: 100, market_available: true },
        { symbol: "OFF-USDT", enabled: false, max_leverage: 50, market_available: true },
      ],
      1,
    );
    expect(u.health).toBe("healthy");
    expect(u.instruments.map((i) => i.symbol)).toEqual(["BTC-USDT", "ETH-USDT"]);
    expect(u.instruments[0].maxLeverage).toBe(100);
  });

  it("Paper adapter with no enabled seeds reports offline", () => {
    const u = buildPaperUniverse([], 1);
    expect(u.health).toBe("offline");
    expect(u.instruments).toEqual([]);
  });
});
