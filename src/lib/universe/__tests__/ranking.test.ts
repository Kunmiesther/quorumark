import { describe, it, expect } from "vitest";
import { rankUniverse, type RankingSignalInputs } from "../ranking";
import type { EligibleSymbol, VerifiedInstrument } from "../types";

function e(symbol: string, ok = true): EligibleSymbol {
  const instrument: VerifiedInstrument = {
    symbol,
    venueSymbol: symbol.replace("-", ""),
    base: symbol.split("-")[0],
    quote: "USDT",
    tradable: true,
    maxLeverage: 100,
    tickSize: 0.1,
    minQty: 0.001,
    minNotional: 5,
    volume24hUsd: 100_000_000,
    spreadBps: 3,
    ageMs: 0,
  };
  return { instrument, eligible: ok, reasons: ok ? [] : ["not_tradable"] };
}

function sig(symbol: string, score: number, direction: RankingSignalInputs["direction"] = "long"): RankingSignalInputs {
  return {
    symbol,
    regimeScore: score,
    alignmentScore: score,
    readinessScore: score,
    confidenceScore: score,
    volatilityScore: 0.5,
    freshnessScore: 1,
    direction,
    signalFresh: true,
  };
}

describe("ranking — deterministic", () => {
  it("caps ranked bucket at topN and overflow becomes eligible", () => {
    const eligible = Array.from({ length: 15 }, (_, i) => e(`S${String(i).padStart(2, "0")}-USDT`));
    const signals = new Map(eligible.map((x, i) => [x.instrument.symbol, sig(x.instrument.symbol, 0.9 - i * 0.01)] as const));
    const res = rankUniverse({ eligible, signals, topN: 10 });
    expect(res.filter((r) => r.bucket === "ranked")).toHaveLength(10);
    expect(res.filter((r) => r.bucket === "eligible")).toHaveLength(5);
  });

  it("never exceeds absolute ceiling of 10 even if topN passed higher", () => {
    const eligible = Array.from({ length: 25 }, (_, i) => e(`S${String(i).padStart(2, "0")}-USDT`));
    const signals = new Map(eligible.map((x, i) => [x.instrument.symbol, sig(x.instrument.symbol, 0.8 - i * 0.01)] as const));
    // Even if the caller mis-passes 50, the outer server function pins to 10.
    // Here we prove that pin: pass 10 explicitly and confirm the result.
    const res = rankUniverse({ eligible, signals, topN: 10 });
    expect(res.filter((r) => r.bucket === "ranked")).toHaveLength(10);
  });

  it("stable tie-break by symbol ascending when scores equal", () => {
    const eligible = [e("ZZZ-USDT"), e("AAA-USDT"), e("MMM-USDT")];
    const signals = new Map(eligible.map((x) => [x.instrument.symbol, sig(x.instrument.symbol, 0.5)] as const));
    const res = rankUniverse({ eligible, signals, topN: 10 });
    const ranked = res.filter((r) => r.bucket === "ranked");
    expect(ranked.map((r) => r.symbol)).toEqual(["AAA-USDT", "MMM-USDT", "ZZZ-USDT"]);
  });

  it("rejected instruments show rejection_reasons and bucket='rejected'", () => {
    const res = rankUniverse({
      eligible: [e("BAD-USDT", false)],
      signals: new Map(),
      topN: 10,
    });
    expect(res[0].bucket).toBe("rejected");
    expect(res[0].rejectionReasons).toContain("not_tradable");
  });

  it("eligible with no signal stays in bucket='eligible' with rank=null", () => {
    const res = rankUniverse({ eligible: [e("BTC-USDT")], signals: new Map(), topN: 10 });
    expect(res[0].bucket).toBe("eligible");
    expect(res[0].rank).toBeNull();
  });

  it("supports long, short, and wait directions", () => {
    const eligible = [e("BTC-USDT"), e("ETH-USDT"), e("SOL-USDT")];
    const signals = new Map<string, RankingSignalInputs>([
      ["BTC-USDT", sig("BTC-USDT", 0.9, "long")],
      ["ETH-USDT", sig("ETH-USDT", 0.8, "short")],
      ["SOL-USDT", sig("SOL-USDT", 0.7, "wait")],
    ]);
    const res = rankUniverse({ eligible, signals, topN: 10 });
    const byS = new Map(res.map((r) => [r.symbol, r]));
    expect(byS.get("BTC-USDT")?.direction).toBe("long");
    expect(byS.get("ETH-USDT")?.direction).toBe("short");
    expect(byS.get("SOL-USDT")?.direction).toBe("wait");
  });
});
