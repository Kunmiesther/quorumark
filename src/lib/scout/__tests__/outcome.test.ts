import { describe, it, expect } from "vitest";
import { evaluateOutcome, WINDOW_MS } from "../outcome";
import type { Candle } from "@/lib/paper/signal";

function mk(count: number, fn: (i: number) => { h: number; l: number; c: number }, startTs = 1_700_000_000_000, stepMs = 60_000): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const b = fn(i);
    out.push([startTs + i * stepMs, b.c, b.h, b.l, b.c, 1000]);
  }
  return out;
}

describe("outcome.evaluateOutcome", () => {
  it("long: hits target when price rises past target %", () => {
    const start = 1_700_000_000_000;
    const candles = mk(30, (i) => ({ h: 100 + i * 0.5 + 0.5, l: 100 + i * 0.5 - 0.5, c: 100 + i * 0.5 }), start, 60_000);
    const r = evaluateOutcome({
      entry_price: 100,
      direction: "long",
      score: 0.5,
      entry_ts_ms: start,
      now: start + 30 * 60_000,
      forward_candles: candles,
    });
    const w15 = r.windows.find((w) => w.window === "15m")!;
    expect(w15.status).toBe("complete");
    expect(w15.target_hit).toBe(true);
    expect(w15.mfe_pct).toBeGreaterThan(0);
  });

  it("short: hits invalidation when price rises against us", () => {
    const start = 1_700_000_000_000;
    const candles = mk(30, (i) => ({ h: 100 + i * 0.8 + 0.5, l: 100 + i * 0.8 - 0.5, c: 100 + i * 0.8 }), start, 60_000);
    const r = evaluateOutcome({
      entry_price: 100,
      direction: "short",
      score: -0.5,
      entry_ts_ms: start,
      now: start + 30 * 60_000,
      forward_candles: candles,
    });
    const w15 = r.windows.find((w) => w.window === "15m")!;
    expect(w15.invalidation_hit).toBe(true);
  });

  it("pending when window not yet elapsed and no touch", () => {
    const start = 1_700_000_000_000;
    // flat price
    const candles = mk(3, () => ({ h: 100.05, l: 99.95, c: 100 }), start, 60_000);
    const r = evaluateOutcome({
      entry_price: 100, direction: "long", score: 0.2,
      entry_ts_ms: start, now: start + 3 * 60_000,
      forward_candles: candles,
    });
    const w1h = r.windows.find((w) => w.window === "1h")!;
    expect(w1h.status).toBe("pending");
  });

  it("insufficient_data when window closed with no candles", () => {
    const start = 1_700_000_000_000;
    const r = evaluateOutcome({
      entry_price: 100, direction: "long", score: 0.2,
      entry_ts_ms: start, now: start + WINDOW_MS["24h"] + 1,
      forward_candles: [],
    });
    const w = r.windows[0];
    expect(w.status).toBe("insufficient_data");
  });

  it("mfe/mae/net signs are consistent for long", () => {
    const start = 1_700_000_000_000;
    // dip then recover
    const candles: Candle[] = [
      [start + 0, 100, 100.2, 99.0, 99.1, 1],
      [start + 60_000, 99.1, 100.3, 99.0, 100.2, 1],
    ];
    const r = evaluateOutcome({
      entry_price: 100, direction: "long", score: 0.2,
      entry_ts_ms: start, now: start + WINDOW_MS["24h"] + 1,
      forward_candles: candles,
    });
    const w = r.windows.find((x) => x.window === "15m")!;
    expect(w.mfe_pct).toBeGreaterThan(0);
    expect(w.mae_pct).toBeGreaterThan(0);
  });
});
