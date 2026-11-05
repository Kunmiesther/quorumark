import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PairBadge, splitAssetPair } from "../PairBadge";
import { CoinBadge } from "../CoinBadge";

describe("asset pair identity", () => {
  it.each(["BTC-USDT", "BTC/USDT", "BTC_USDT", "BTCUSDT"])("parses %s", (symbol) => {
    expect(splitAssetPair(symbol)).toEqual(["BTC", "USDT"]);
  });
  it("does not invent a quote for a bare asset", () => {
    expect(splitAssetPair("SOL")).toEqual(["SOL", null]);
  });
  it("renders both logos while preserving the readable instrument label", () => {
    const html = renderToStaticMarkup(<PairBadge symbol="BTC-USDT" />);
    expect(html).toContain("btc.svg");
    expect(html).toContain("usdt.svg");
    expect(html).toContain("BTC-USDT");
  });
  it("uses Solana's official gradient mark, not the legacy green disc", () => {
    const html = renderToStaticMarkup(<CoinBadge symbol="SOL" />);
    expect(html).toContain("solana.com/src/img/branding/solanaLogoMark.svg");
    expect(html).not.toContain("/sol.svg");
  });
});
