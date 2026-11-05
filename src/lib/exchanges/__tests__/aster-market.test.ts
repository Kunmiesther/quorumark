import { describe, expect, it } from "vitest";

import { normalizeAsterMarkets } from "../../../../supabase/functions/_shared/exchange-adapter";

describe("normalizeAsterMarkets", () => {
  it("normalizes active Aster V3 perpetual markets", () => {
    const markets = normalizeAsterMarkets({
      symbols: [
        {
          symbol: "ETHUSDT",
          baseAsset: "ETH",
          quoteAsset: "USDT",
          status: "TRADING",
          pricePrecision: 2,
          quantityPrecision: 3,
        },
      ],
    });

    expect(markets).toEqual([
      {
        symbol: "ETHUSDT",
        base: "ETH",
        quote: "USDT",
      },
    ]);
  });

  it("returns an empty list for malformed payloads", () => {
    expect(normalizeAsterMarkets(null)).toEqual([]);
    expect(normalizeAsterMarkets({ symbols: "bad" })).toEqual([]);
  });
});
