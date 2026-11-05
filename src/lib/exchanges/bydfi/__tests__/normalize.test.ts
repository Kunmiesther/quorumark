import { describe, expect, it } from "vitest";
import { normalizeExchangeInfo, normalizeAccountAssets, canonicaliseBydfiSymbol } from "../normalize";
import { normalizeUpstreamError } from "../errors";

describe("bydfi/normalize", () => {
  it("canonicalises native futures symbols", () => {
    expect(canonicaliseBydfiSymbol("BTCUSDT")).toBe("BTC-USDT");
    expect(canonicaliseBydfiSymbol("ETHUSDT")).toBe("ETH-USDT");
    expect(canonicaliseBydfiSymbol("SOLUSDC")).toBe("SOL-USDC");
    expect(canonicaliseBydfiSymbol("")).toBeNull();
    expect(canonicaliseBydfiSymbol("USDT")).toBeNull();
  });

  it("normalises /account/assets into a safe identity DTO", () => {
    const raw = { data: { assets: [{ asset: "USDT", walletBalance: "12.5" }] } };
    const id = normalizeAccountAssets(raw);
    expect(id.authOk).toBe(true);
    expect(id.assetCount).toBe(1);
    // Withdrawal permission is NEVER claimed verified from this endpoint.
    expect(id.withdrawalPermitted).toBeNull();
    expect(id.withdrawalDisabledVerified).toBe(false);
  });

  it("normalises exchange_info into VerifiedInstrument rows", () => {
    const raw = {
      symbols: [
        { symbol: "BTCUSDT", status: "TRADING", maxLeverage: 125, tickSize: 0.1, minQty: 0.001, minNotional: 5, quoteVolume: 1_000_000_000 },
        { symbol: "ETHUSDT", status: "TRADING", maxLeverage: 100 },
        { symbol: "BROKEN", status: "TRADING" }, // no quote suffix → dropped
      ],
    };
    const rows = normalizeExchangeInfo(raw, Date.now());
    expect(rows.map((r) => r.symbol)).toEqual(["BTC-USDT", "ETH-USDT"]);
    expect(rows[0].maxLeverage).toBe(125);
    expect(rows[0].volume24hUsd).toBe(1_000_000_000);
    expect(rows[0].tradable).toBe(true);
  });
});

describe("bydfi/errors", () => {
  it("maps 401 signature failures to signature_rejected", () => {
    expect(normalizeUpstreamError(401, JSON.stringify({ msg: "invalid signature" })).code).toBe("signature_rejected");
  });
  it("maps 401 with expired timestamp to timestamp_expired", () => {
    expect(normalizeUpstreamError(401, JSON.stringify({ msg: "timestamp expired" })).code).toBe("timestamp_expired");
  });
  it("maps 403 permission to permission_denied", () => {
    expect(normalizeUpstreamError(403, JSON.stringify({ msg: "permission denied" })).code).toBe("permission_denied");
  });
  it("maps 429 to rate_limited", () => {
    expect(normalizeUpstreamError(429, "").code).toBe("rate_limited");
  });
  it("maps 5xx to http_error", () => {
    expect(normalizeUpstreamError(503, "").code).toBe("http_error");
  });
});
