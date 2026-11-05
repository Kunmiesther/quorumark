/**
 * Deterministic tests for evidence.ts. Uses synthetic candles so results are
 * reproducible on any machine.
 */
import { describe, it, expect } from "vitest";
import { buildEvidence } from "../evidence";
import type { Candle } from "@/lib/paper/signal";

function mkCandles(count: number, gen: (i: number) => { o: number; h: number; l: number; c: number; v: number }, startTs = 1_700_000_000_000, stepMs = 60_000): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const b = gen(i);
    out.push([startTs + i * stepMs, b.o, b.h, b.l, b.c, b.v]);
  }
  return out;
}

function trendUp(count = 120): Candle[] {
  return mkCandles(count, (i) => {
    const base = 100 + i * 0.5; // steady uptrend
    return { o: base, h: base + 0.6, l: base - 0.4, c: base + 0.3, v: 1000 };
  });
}
function trendDown(count = 120): Candle[] {
  return mkCandles(count, (i) => {
    const base = 200 - i * 0.5;
    return { o: base, h: base + 0.4, l: base - 0.6, c: base - 0.3, v: 1000 };
  });
}

describe("evidence.buildEvidence", () => {
  it("returns direction=none with reasons on insufficient history", () => {
    const c = trendUp(10);
    const e = buildEvidence({ symbol: "BTC-USDT", timeframe: "H1", candles: c, now: c.at(-1)![0] + 1_000 });
    expect(e.direction).toBe("none");
    expect(e.score).toBe(0);
    expect(e.reason_codes).toContain("insufficient_history");
  });

  it("fail-closed on stale data", () => {
    const c = trendUp(120);
    const e = buildEvidence({ symbol: "BTC-USDT", timeframe: "H1", candles: c, now: c.at(-1)![0] + 24 * 60 * 60 * 1000 });
    expect(e.direction).toBe("none");
    expect(e.reason_codes).toContain("stale_data");
  });

  it("emits long direction + bullish reasons on clean uptrend", () => {
    const c = trendUp(120);
    const e = buildEvidence({ symbol: "BTC-USDT", timeframe: "M5", candles: c, now: c.at(-1)![0] + 1_000 });
    expect(e.direction).toBe("long");
    expect(e.score).toBeGreaterThan(0.3);
    expect(e.reason_codes).toContain("ema_stack_up");
    expect(e.ema.stack).toBe("up");
    expect(e.ema.slope_pct).toBeGreaterThan(0);
  });

  it("emits short direction on clean downtrend", () => {
    const c = trendDown(120);
    const e = buildEvidence({ symbol: "ETH-USDT", timeframe: "M5", candles: c, now: c.at(-1)![0] + 1_000 });
    expect(e.direction).toBe("short");
    expect(e.score).toBeLessThan(-0.3);
    expect(e.reason_codes).toContain("ema_stack_down");
  });

  it("keeps score bounded to [-1, +1]", () => {
    const c = trendUp(120);
    const e = buildEvidence({ symbol: "BTC-USDT", timeframe: "H1", candles: c, now: c.at(-1)![0] + 1_000 });
    expect(e.score).toBeGreaterThanOrEqual(-1);
    expect(e.score).toBeLessThanOrEqual(1);
  });

  it("compact snapshot serializes to a reasonable byte size", () => {
    const c = trendUp(120);
    const e = buildEvidence({ symbol: "BTC-USDT", timeframe: "H1", candles: c, now: c.at(-1)![0] + 1_000 });
    const bytes = new TextEncoder().encode(JSON.stringify(e)).byteLength;
    expect(bytes).toBeLessThan(4096);
  });

  it("flags missing_fields defensively", () => {
    const c = trendUp(120);
    // Corrupt the last candle's close.
    const bad = [...c];
    const last = [...bad[bad.length - 1]] as Candle;
    last[4] = Number.NaN;
    bad[bad.length - 1] = last;
    const e = buildEvidence({ symbol: "BTC-USDT", timeframe: "H1", candles: bad, now: bad.at(-1)![0] + 1_000 });
    expect(e.reason_codes).toContain("missing_fields");
    expect(e.direction).toBe("none");
  });

  it("carries version tag", () => {
    const c = trendUp(120);
    const e = buildEvidence({ symbol: "BTC-USDT", timeframe: "H1", candles: c, now: c.at(-1)![0] + 1_000 });
    expect(e.evidence_schema_version).toBeGreaterThan(0);
    expect(e.rules_version).toBeGreaterThan(0);
  });
});
