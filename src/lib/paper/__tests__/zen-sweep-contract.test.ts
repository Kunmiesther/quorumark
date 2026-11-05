import { describe, expect, it } from "vitest";
import {
  CANONICAL_SCAN_SYMBOLS,
  ZEN_SWEEP,
  alignmentVotes,
  buildZenSweepLadder,
  decideZenSweepExit,
  isCanonicalScanSymbol,
  passesZenSweepAlignment,
} from "../zenSweepContract";

describe("zen_sweep_v1 canonical contract", () => {
  it("scans exactly BTC, XRP, SOL, and ETH without assigning strategies by symbol", () => {
    expect(CANONICAL_SCAN_SYMBOLS).toEqual([
      "BTC-USDT", "XRP-USDT", "SOL-USDT", "ETH-USDT",
    ]);
    for (const symbol of CANONICAL_SCAN_SYMBOLS) {
      expect(isCanonicalScanSymbol(symbol)).toBe(true);
    }
    expect(isCanonicalScanSymbol("DOGE-USDT")).toBe(false);
  });

  it.each(CANONICAL_SCAN_SYMBOLS)(
    "%s receives identical five-rung, 0.5%-spacing, 5%-margin behavior",
    () => {
      const rungs = buildZenSweepLadder({
        direction: "long",
        alertPrice: 100,
        leverage: 50,
        availableEquity: 2_500,
      });
      expect(rungs).toHaveLength(5);
      expect(rungs.map((r) => r.price)).toEqual([100, 99.5, 99, 98.5, 98]);
      expect(rungs.reduce((sum, rung) => sum + rung.margin, 0)).toBeCloseTo(125, 10);
      expect(rungs.every((rung) => rung.margin === 25)).toBe(true);
    },
  );

  it("requires any two of 1h/4h/1d to align with the proposed direction", () => {
    const states = ["bullish_bos", "none", "bullish_bos"] as const;
    expect(alignmentVotes("long", states)).toBe(2);
    expect(passesZenSweepAlignment("long", states)).toBe(true);
    expect(passesZenSweepAlignment("short", states)).toBe(false);
  });

  it("closes half at +100% net ROI, then ratchets and closes the rest", () => {
    const first = decideZenSweepExit({
      bankedNetPnl: 0,
      openNetPnl: 125,
      initialMargin: 125,
      firstTargetTaken: false,
    });
    expect(first.action).toBe("close_half");

    const runner = decideZenSweepExit({
      bankedNetPnl: 62.5,
      openNetPnl: 125,
      initialMargin: 125,
      firstTargetTaken: true,
      previousHighWaterRoiPct: 140,
    });
    expect(runner.action).toBe("hold");
    expect(runner.highWaterRoiPct).toBe(150);
    expect(runner.trailingFloorRoiPct).toBe(100);

    const trailing = decideZenSweepExit({
      bankedNetPnl: 62.5,
      openNetPnl: 50,
      initialMargin: 125,
      firstTargetTaken: true,
      previousHighWaterRoiPct: 150,
    });
    expect(trailing.action).toBe("close_all_trailing");
    expect(ZEN_SWEEP.exit.final_target_margin_roi_pct).toBe(200);
  });
});
