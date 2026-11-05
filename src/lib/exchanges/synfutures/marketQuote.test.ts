// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { quoteSynFuturesMarket, type QuoteReader } from "./marketQuote.server";
const instrument = "0x0000000000000000000000000000000000000001" as const;
const unit = 10n ** 18n;
const probe = {
  contracts_deployed: true,
  observer_read_compatible: true,
  chain_id: 8453,
  markets: [
    {
      instrument,
      symbol: "BTC-USDC",
      quote_token: instrument,
      quote_decimals: 6,
      initial_margin_bps: 300,
      expiries: [4294967295, 1],
    },
  ],
};
const input = { instrument, expiry: 4294967295, side: "long" as const, notional: "100" };
function reader(): QuoteReader {
  return {
    chainId: vi.fn().mockResolvedValue(8453),
    quote: vi
      .fn()
      .mockResolvedValue([
        unit / 100n,
        { mark: 10000n * unit, entryNotional: 100n * unit, fee: unit / 10n },
      ]),
  };
}
describe("SynFutures indicative quote", () => {
  it("uses instrument 18-decimal units even for a 6-decimal collateral token", async () => {
    const rpc = reader();
    expect(await quoteSynFuturesMarket(input, probe, rpc)).toMatchObject({
      base_size: "0.01",
      entry_notional: "100",
      average_entry: "10000",
      fee: "0.1",
      execution_ready: false,
    });
    expect(rpc.quote).toHaveBeenCalledWith(instrument, 4294967295, 100n * unit, true);
  });
  it("formats short size positively without losing direction", async () => {
    const rpc = reader();
    rpc.quote = vi
      .fn()
      .mockResolvedValue([
        -unit / 100n,
        { mark: 10000n * unit, entryNotional: 100n * unit, fee: 0n },
      ]);
    expect(await quoteSynFuturesMarket({ ...input, side: "short" }, probe, rpc)).toMatchObject({
      base_size: "0.01",
      side: "short",
    });
  });
  it.each(["0", "-1", "1e2", "1.0000000000000000001", "1000000000000", "NaN"])(
    "rejects invalid notional %s before RPC",
    async (notional) => {
      const rpc = reader();
      await expect(quoteSynFuturesMarket({ ...input, notional }, probe, rpc)).rejects.toThrow();
      expect(rpc.chainId).not.toHaveBeenCalled();
    },
  );
  it("requires discovered instrument and expiry", async () => {
    await expect(
      quoteSynFuturesMarket(
        { ...input, instrument: "0x0000000000000000000000000000000000000002" },
        probe,
        reader(),
      ),
    ).rejects.toThrow("MARKET_NOT_LISTED");
    await expect(quoteSynFuturesMarket({ ...input, expiry: 2 }, probe, reader())).rejects.toThrow(
      "MARKET_NOT_LISTED",
    );
    await expect(quoteSynFuturesMarket({ ...input, expiry: 1 }, probe, reader())).rejects.toThrow(
      "MARKET_EXPIRED",
    );
  });
  it("requires verified registry and chain", async () => {
    await expect(
      quoteSynFuturesMarket(input, { ...probe, observer_read_compatible: false }, reader()),
    ).rejects.toThrow("REGISTRY_NOT_VERIFIED");
    const rpc = reader();
    rpc.chainId = vi.fn().mockResolvedValue(1);
    await expect(quoteSynFuturesMarket(input, probe, rpc)).rejects.toThrow("RPC_CHAIN_MISMATCH");
    expect(rpc.quote).not.toHaveBeenCalled();
  });
  it.each([0n, -1n])("rejects invalid long quantity %s", async (size) => {
    const rpc = reader();
    rpc.quote = vi.fn().mockResolvedValue([size, { mark: unit, entryNotional: unit, fee: 0n }]);
    await expect(quoteSynFuturesMarket(input, probe, rpc)).rejects.toThrow("INVALID_QUOTE_RESULT");
  });
});
