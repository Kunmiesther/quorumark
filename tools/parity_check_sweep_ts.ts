/**
 * Cross-lang parity harness: runs the TS sweep detector on every parity
 * fixture and prints entry/mode/direction/stop as JSON so the Python
 * harness (tools/parity_check_sweep.py) can assert bit-identical output.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Candle } from "../src/lib/paper/signal";
import { HIGH, LOW, CLOSE } from "../src/lib/paper/signal";
import { detectSweep } from "../src/lib/paper/sweep";
const SWEEP_ATR_PERIOD = 14;


function atrSeries(candles: Candle[], period: number): (number | null)[] {
  const n = candles.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return out;
  const trs: number[] = [];
  for (let i = 1; i < n; i++) {
    const h = candles[i][HIGH], l = candles[i][LOW], pc = candles[i - 1][CLOSE];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let avg = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period] = avg;
  for (let i = period + 1; i < n; i++) {
    avg = (avg * (period - 1) + trs[i - 1]) / period;
    out[i] = avg;
  }
  return out;
}

const dir = resolve(process.cwd(), "tests/fixtures/parity");
const out: Record<string, unknown> = {};
for (const f of readdirSync(dir)) {
  if (!f.startsWith("sweep_1h_") || f.includes("momentum")) continue;
  const fx = JSON.parse(readFileSync(resolve(dir, f), "utf-8"));
  const atr = atrSeries(fx.candles_1h as Candle[], SWEEP_ATR_PERIOD);
  const r = detectSweep({
    candles: fx.candles_1h,
    atr,
    htfBosState: fx.htf_bos_state ?? "none",
    tick: fx.tick ?? 0,
  });

  out[f] = r == null ? null : {
    direction: r.direction, mode: r.mode,
    entry: r.entry, stop: r.stop,
    swept_level: r.sweptLevel, level_source: r.levelSource,
    tp_distance: r.tpDistance,
  };
}
console.log(JSON.stringify(out, null, 2));

