import { describe, it, expect } from "vitest";
import { legForRegime, dbStrategyLabel, TREND_FRESH_MAX_CANDLES } from "./routing";

describe("legForRegime — regime → leg mapping", () => {
  it("maps non-trend regimes deterministically (trend_age ignored)", () => {
    expect(legForRegime("high_vol")).toBe("hunter");
    expect(legForRegime("neutral")).toBe("sweep");
    expect(legForRegime("high_vol", 999)).toBe("hunter");
    expect(legForRegime("neutral", 1)).toBe("sweep");
  });

  it("arms nothing when the regime is undecided", () => {
    expect(legForRegime(null)).toBeNull();
    expect(legForRegime(null, 5)).toBeNull();
  });

  it("backward-compat: trend without trend_age falls through to accumulator", () => {
    expect(legForRegime("trend")).toBe("accumulator");
    expect(legForRegime("trend", null)).toBe("accumulator");
  });

  it("trend split by age: fresh → vanguard, aged → accumulator", () => {
    expect(legForRegime("trend", 1)).toBe("vanguard");
    expect(legForRegime("trend", TREND_FRESH_MAX_CANDLES)).toBe("vanguard");
    expect(legForRegime("trend", TREND_FRESH_MAX_CANDLES + 1)).toBe("accumulator");
    expect(legForRegime("trend", 10_000)).toBe("accumulator");
  });

  it("boundary is inclusive at TREND_FRESH_MAX_CANDLES", () => {
    expect(legForRegime("trend", TREND_FRESH_MAX_CANDLES)).toBe("vanguard");
    expect(legForRegime("trend", TREND_FRESH_MAX_CANDLES + 1)).toBe("accumulator");
  });

  it("neutral arms sweep — never hunter/accumulator/vanguard/sniper", () => {
    const leg = legForRegime("neutral");
    expect(leg).toBe("sweep");
    expect(leg).not.toBe("hunter");
    expect(leg).not.toBe("accumulator");
    expect(leg).not.toBe("vanguard");
    expect(leg).not.toBe("sniper");
  });

  it("DB strategy label continuity: sweep persists as 'sniper'", () => {
    expect(dbStrategyLabel("sweep")).toBe("sniper");
    expect(dbStrategyLabel("sniper")).toBe("sniper");
    expect(dbStrategyLabel("hunter")).toBe("hunter");
    expect(dbStrategyLabel("accumulator")).toBe("accumulator");
    expect(dbStrategyLabel("vanguard")).toBe("vanguard");
  });
});
