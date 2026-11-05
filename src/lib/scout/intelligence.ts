/**
 * Deterministic per-timeframe intelligence scoring.
 *
 * Pure. NEVER touches paper engine, orders, wallets, Onyx execution.
 */
import { CLOSE, HIGH, LOW, wilderAtrSeries, computeTrend, type Candle } from "@/lib/paper/signal";
import {
  TIMEFRAME_MS,
  TIMEFRAME_STALE_MULT,
  type ReasonCode,
  type TfState,
  type Timeframe,
  type TimeframeState,
} from "./types";

// Per-timeframe EMA config. Higher timeframes typically have less available
// history from the exchange (e.g. ApeX Omni returns ~26 monthly candles), so
// M and W use shorter EMAs / smaller minimum history.
const EMA_CONFIG: Record<Timeframe, { fast: number; slow: number; min: number }> = {
  M: { fast: 6, slow: 12, min: 15 },
  W: { fast: 10, slow: 30, min: 35 },
  D: { fast: 20, slow: 50, min: 55 },
  H4: { fast: 20, slow: 50, min: 55 },
  H1: { fast: 20, slow: 50, min: 55 },
  M15: { fast: 20, slow: 50, min: 55 },
  M5: { fast: 20, slow: 50, min: 55 },
};

function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Detect a recent break-of-structure (last 20 closed candles vs prior swing). */
function detectBos(candles: Candle[]): "up" | "down" | null {
  const n = candles.length;
  if (n < 25) return null;
  const window = candles.slice(-25, -1);
  const last = candles[n - 1];
  let priorHigh = -Infinity;
  let priorLow = Infinity;
  for (const c of window) {
    if (c[HIGH] > priorHigh) priorHigh = c[HIGH];
    if (c[LOW] < priorLow) priorLow = c[LOW];
  }
  if (last[CLOSE] > priorHigh) return "up";
  if (last[CLOSE] < priorLow) return "down";
  return null;
}

/**
 * Score a single timeframe from its completed candles.
 *
 * Score is signed -1..+1:
 *   +1  strong bullish (EMA stack up + slope + BOS up)
 *   -1  strong bearish
 *    0  neutral / mixed
 *
 * `now` allows deterministic staleness testing.
 */
export function scoreTimeframe(
  tf: Timeframe,
  candles: Candle[],
  now = Date.now(),
): TimeframeState {
  const reasons: ReasonCode[] = [];

  if (candles.length === 0) {
    return {
      tf,
      state: "unavailable",
      score: 0,
      lastClosedTs: null,
      ageMs: null,
      stale: true,
      reasons: ["insufficient_history"],
    };
  }

  const lastClosedTs = candles[candles.length - 1][0];
  const intervalMs = TIMEFRAME_MS[tf];
  const ageMs = Math.max(0, now - lastClosedTs);
  const stale = ageMs > intervalMs * TIMEFRAME_STALE_MULT[tf];
  if (stale) reasons.push("stale_data");

  const cfg = EMA_CONFIG[tf];
  if (candles.length < cfg.min) {
    reasons.push("insufficient_history");
    return {
      tf,
      state: "unavailable",
      score: 0,
      lastClosedTs,
      ageMs,
      stale,
      reasons,
    };
  }

  const closes = candles.map((c) => c[CLOSE]);
  const emaF = ema(closes, cfg.fast);
  const emaS = ema(closes, cfg.slow);
  const i = closes.length - 1;
  const fastNow = emaF[i];
  const slowNow = emaS[i];
  const fastPrev = emaF[Math.max(0, i - 5)];
  const slowPrev = emaS[Math.max(0, i - 5)];

  if (fastNow == null || slowNow == null || fastPrev == null || slowPrev == null) {
    reasons.push("insufficient_history");
    return { tf, state: "unavailable", score: 0, lastClosedTs, ageMs, stale, reasons };
  }

  // Trend (reuses paper engine's EMA + slope).
  const trend = computeTrend(candles);

  // EMA stack
  const stackUp = fastNow > slowNow && closes[i] > fastNow;
  const stackDn = fastNow < slowNow && closes[i] < fastNow;
  if (stackUp) reasons.push("ema_stack_up");
  if (stackDn) reasons.push("ema_stack_down");

  // Slope of fast EMA
  const slopeFast = (fastNow - fastPrev) / (fastPrev || 1);
  if (Math.abs(slopeFast) < 0.001) reasons.push("slope_flat");

  // Range compression via ATR% vs its own 50-bar median
  const atr = wilderAtrSeries(candles);
  const atrNow = atr[i];
  const price = closes[i];
  if (atrNow != null && price > 0) {
    const atrPct = atrNow / price;
    const recent = atr.slice(-50).filter((v): v is number => v != null && v > 0);
    if (recent.length >= 20) {
      const sorted = [...recent].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] / price;
      if (atrPct < median * 0.6) reasons.push("range_compression");
      if (atrPct > median * 1.8) reasons.push("atr_spike");
    }
  }

  const bos = detectBos(candles);
  if (bos === "up") reasons.push("bos_up");
  if (bos === "down") reasons.push("bos_down");

  // Score composition
  let score = 0;
  if (stackUp) score += 0.4;
  if (stackDn) score -= 0.4;
  score += Math.max(-0.3, Math.min(0.3, slopeFast * 15));
  if (bos === "up") score += 0.25;
  if (bos === "down") score -= 0.25;
  if (trend.state === "up") score += 0.1;
  if (trend.state === "down") score -= 0.1;
  score = Math.max(-1, Math.min(1, score));

  let state: TfState;
  const bullVotes = (stackUp ? 1 : 0) + (bos === "up" ? 1 : 0) + (trend.state === "up" ? 1 : 0);
  const bearVotes = (stackDn ? 1 : 0) + (bos === "down" ? 1 : 0) + (trend.state === "down" ? 1 : 0);
  if (stale) {
    state = "unavailable";
  } else if (bullVotes >= 2 && bearVotes === 0) state = "bullish";
  else if (bearVotes >= 2 && bullVotes === 0) state = "bearish";
  else if (bullVotes > 0 && bearVotes > 0) state = "mixed";
  else state = "neutral";

  return { tf, state, score, lastClosedTs, ageMs, stale, reasons };
}
