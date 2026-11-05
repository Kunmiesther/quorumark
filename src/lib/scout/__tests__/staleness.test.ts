/**
 * Regression: TIMEFRAME_STALE_MULT must keep the newest CLOSED candle fresh
 * for the entire bucket that follows it. A too-tight multiplier (≤ 2.0 on
 * D/W/M) was the root cause of Scout HEALTH=DEGRADED with the message
 * "Higher-timeframe context missing or stale — no bias published."
 */
import { describe, expect, it } from "vitest";
import { scoreTimeframe } from "../intelligence";
import { TIMEFRAMES, TIMEFRAME_MS, TIMEFRAME_STALE_MULT } from "../types";
import type { Candle } from "@/lib/paper/signal";

// 60 uniformly-spaced synthetic closed candles ending at `lastCloseTs`.
function synthClosed(lastCloseTs: number, intervalMs: number, n = 60): Candle[] {
  const out: Candle[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = lastCloseTs - i * intervalMs;
    const price = 100 + i * 0.1;
    out.push([t, price, price + 0.5, price - 0.5, price + 0.2, 1]);
  }
  return out;
}

describe("timeframe staleness invariant", () => {
  it("multiplier is > 2.0 for every timeframe (so the newest closed bar can survive one full bucket)", () => {
    for (const tf of TIMEFRAMES) {
      // Intraday tolerances (H4/H1/M15/M5) are already > 2, higher TFs must be too.
      expect(TIMEFRAME_STALE_MULT[tf], `${tf} multiplier`).toBeGreaterThan(2);
    }
  });

  it("the newest closed daily candle is NOT stale immediately before the next close", () => {
    const intervalMs = TIMEFRAME_MS.D;
    const lastCloseTs = 1_784_419_200_000; // 2026-07-20 00:00 UTC
    // Wall clock: one millisecond before the next daily close, i.e. ~24h - 1ms
    // AFTER the newest closed bar. Under the old mult=1.5 this bar was stale
    // any time > 12:00 UTC. Under >2.0 it stays fresh.
    const now = lastCloseTs + 2 * intervalMs - 1;
    const state = scoreTimeframe("D", synthClosed(lastCloseTs, intervalMs), now);
    expect(state.stale).toBe(false);
    expect(state.state).not.toBe("unavailable");
  });

  it("daily becomes stale only AFTER the next expected close has been missed by the configured slack", () => {
    const intervalMs = TIMEFRAME_MS.D;
    const lastCloseTs = 1_784_419_200_000;
    const cutoff = intervalMs * TIMEFRAME_STALE_MULT.D;
    const state = scoreTimeframe(
      "D",
      synthClosed(lastCloseTs, intervalMs),
      lastCloseTs + cutoff + 60_000,
    );
    expect(state.stale).toBe(true);
  });

  it("weekly newest closed bar is fresh right before the next weekly close", () => {
    const intervalMs = TIMEFRAME_MS.W;
    const lastCloseTs = 1_783_900_800_000;
    const now = lastCloseTs + 2 * intervalMs - 1;
    const state = scoreTimeframe("W", synthClosed(lastCloseTs, intervalMs), now);
    expect(state.stale).toBe(false);
  });

  it("monthly newest closed bar is fresh right before the next monthly close", () => {
    const intervalMs = TIMEFRAME_MS.M;
    const lastCloseTs = 1_780_272_000_000;
    const now = lastCloseTs + 2 * intervalMs - 1;
    const state = scoreTimeframe("M", synthClosed(lastCloseTs, intervalMs), now);
    expect(state.stale).toBe(false);
  });
});
