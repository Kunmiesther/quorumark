/**
 * Deterministic per-(symbol, timeframe) evidence producer.
 *
 * PURE. Consumes closed candles, produces a compact `CompactEvidence` snapshot
 * with reason codes and a signed score in [-1, +1]. NEVER touches paper
 * engine, orders, wallets, execution, or an LLM.
 *
 * The snapshot is designed to be small enough to persist as JSONB for every
 * (user, scan, symbol, tf) row without bloating storage — no raw candle
 * arrays, only summarised numbers and ts ranges.
 *
 * READ-ONLY MODULE. See `scout-no-execution-imports.test.ts`.
 */

import { CLOSE, HIGH, LOW, OPEN, VOLUME, type Candle } from "@/lib/paper/signal";
import { TIMEFRAME_MS, TIMEFRAME_STALE_MULT, type Timeframe } from "./types";
import type { EvidenceReasonCode } from "./reasonCodes";
import { EVIDENCE_SCHEMA_VERSION, RULES_VERSION } from "./versions";

export type EvidenceDirection = "long" | "short" | "none";

export interface DataQuality {
  candle_count: number;
  last_closed_ts: number | null;
  age_ms: number | null;
  fresh: boolean;
  missing_fields: string[];
}

export interface StructureFacet {
  hh: boolean;
  hl: boolean;
  lh: boolean;
  ll: boolean;
  range: boolean;
  bos: "up" | "down" | null;
  choch: "up" | "down" | null;
  failed_breakout: "up" | "down" | null;
}

export interface EmaFacet {
  fast: number | null;
  slow: number | null;
  stack: "up" | "down" | "mixed" | "flat";
  slope_pct: number; // fast EMA % change over ~5 closed candles
}

export interface MomentumFacet {
  roc_pct: number; // % change over 10 closed candles
  rsi14: number | null;
  norm: number; // [-1, +1]
}

export interface VolumeFacet {
  last: number;
  median50: number;
  ratio: number; // last / median
}

export interface VolatilityFacet {
  atr_pct: number | null;
  atr_percentile: number | null; // 0..1 vs rolling 100
  regime: "expansion" | "contraction" | "normal";
}

export interface CompactEvidence {
  symbol: string;
  timeframe: Timeframe;
  direction: EvidenceDirection;
  score: number; // [-1, +1]
  reason_codes: EvidenceReasonCode[];
  structure: StructureFacet;
  ema: EmaFacet;
  momentum: MomentumFacet;
  volume: VolumeFacet;
  volatility: VolatilityFacet;
  data_quality: DataQuality;
  evidence_schema_version: number;
  rules_version: number;
}

// ------------------------------ helpers ------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

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

function trueRange(c: Candle, prevClose: number | null): number {
  const hl = c[HIGH] - c[LOW];
  if (prevClose == null) return hl;
  return Math.max(hl, Math.abs(c[HIGH] - prevClose), Math.abs(c[LOW] - prevClose));
}

function wilderAtr(candles: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  let atr = 0;
  for (let i = 1; i <= period; i++) {
    atr += trueRange(candles[i], candles[i - 1][CLOSE]);
  }
  atr /= period;
  out[period] = atr;
  for (let i = period + 1; i < candles.length; i++) {
    const tr = trueRange(candles[i], candles[i - 1][CLOSE]);
    atr = (atr * (period - 1) + tr) / period;
    out[i] = atr;
  }
  return out;
}

function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  if (gains + losses === 0) return 50;
  const rs = gains / (losses || 1e-12);
  return 100 - 100 / (1 + rs);
}

/** Detect swing pivots with 2-left/2-right confirmation over the last N closed candles. */
function pivots(candles: Candle[], lookback = 30): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  const start = Math.max(2, candles.length - lookback);
  for (let i = start; i < candles.length - 2; i++) {
    const h = candles[i][HIGH];
    const l = candles[i][LOW];
    if (
      h > candles[i - 1][HIGH] && h > candles[i - 2][HIGH] &&
      h > candles[i + 1][HIGH] && h > candles[i + 2][HIGH]
    ) highs.push(h);
    if (
      l < candles[i - 1][LOW] && l < candles[i - 2][LOW] &&
      l < candles[i + 1][LOW] && l < candles[i + 2][LOW]
    ) lows.push(l);
  }
  return { highs, lows };
}

function detectStructure(candles: Candle[]): StructureFacet {
  const { highs, lows } = pivots(candles);
  const hh = highs.length >= 2 && highs[highs.length - 1] > highs[highs.length - 2];
  const hl = lows.length >= 2 && lows[lows.length - 1] > lows[lows.length - 2];
  const lh = highs.length >= 2 && highs[highs.length - 1] < highs[highs.length - 2];
  const ll = lows.length >= 2 && lows[lows.length - 1] < lows[lows.length - 2];
  const range = highs.length >= 2 && lows.length >= 2 && !hh && !ll && !lh && !hl;

  // BOS: last close breaks the most recent opposite pivot in trend direction.
  let bos: "up" | "down" | null = null;
  const last = candles[candles.length - 1];
  if (highs.length && last[CLOSE] > highs[highs.length - 1]) bos = "up";
  else if (lows.length && last[CLOSE] < lows[lows.length - 1]) bos = "down";

  // CHOCH: prior trend was down (LH/LL) and last closes above prior swing high, or reverse.
  let choch: "up" | "down" | null = null;
  if (bos === "up" && lh && ll) choch = "up";
  if (bos === "down" && hh && hl) choch = "down";

  // Failed breakout: prior 3 candles closed above pivotHigh but the *last* closes back inside.
  let failed: "up" | "down" | null = null;
  if (highs.length && candles.length >= 4) {
    const ph = highs[highs.length - 1];
    const w = candles.slice(-4, -1);
    if (w.some((c) => c[HIGH] > ph) && last[CLOSE] < ph) failed = "up";
  }
  if (!failed && lows.length && candles.length >= 4) {
    const pl = lows[lows.length - 1];
    const w = candles.slice(-4, -1);
    if (w.some((c) => c[LOW] < pl) && last[CLOSE] > pl) failed = "down";
  }

  return { hh, hl, lh, ll, range, bos, choch, failed_breakout: failed };
}

// ------------------------------ main ------------------------------

export interface EvidenceInput {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  now?: number;
}

/**
 * Build a `CompactEvidence` from closed candles. Fail-closed: when history is
 * insufficient or the last candle is stale, returns `direction: 'none'`,
 * `score: 0`, with explanatory reason codes.
 */
export function buildEvidence(input: EvidenceInput): CompactEvidence {
  const { symbol, timeframe, candles, now = Date.now() } = input;
  const reasons: EvidenceReasonCode[] = [];
  const missing: string[] = [];

  // Detect missing fields on last candle (defensive; upstream should filter).
  if (candles.length > 0) {
    const last = candles[candles.length - 1];
    for (const [name, idx] of [
      ["open", OPEN],
      ["high", HIGH],
      ["low", LOW],
      ["close", CLOSE],
    ] as const) {
      const v = last[idx];
      if (typeof v !== "number" || !Number.isFinite(v)) missing.push(name);
    }
    if (missing.length) reasons.push("missing_fields");
  }

  const lastClosedTs = candles.length ? candles[candles.length - 1][0] : null;
  const intervalMs = TIMEFRAME_MS[timeframe];
  const ageMs = lastClosedTs == null ? null : Math.max(0, now - lastClosedTs);
  const fresh = ageMs != null && ageMs <= intervalMs * TIMEFRAME_STALE_MULT[timeframe];
  if (!fresh) reasons.push("stale_data");

  const dq: DataQuality = {
    candle_count: candles.length,
    last_closed_ts: lastClosedTs,
    age_ms: ageMs,
    fresh,
    missing_fields: missing,
  };

  const empty = (): CompactEvidence => ({
    symbol,
    timeframe,
    direction: "none",
    score: 0,
    reason_codes: reasons,
    structure: { hh: false, hl: false, lh: false, ll: false, range: false, bos: null, choch: null, failed_breakout: null },
    ema: { fast: null, slow: null, stack: "flat", slope_pct: 0 },
    momentum: { roc_pct: 0, rsi14: null, norm: 0 },
    volume: { last: 0, median50: 0, ratio: 0 },
    volatility: { atr_pct: null, atr_percentile: null, regime: "normal" },
    data_quality: dq,
    evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
    rules_version: RULES_VERSION,
  });

  if (candles.length < 55 || missing.length > 0 || !fresh) {
    if (candles.length < 55) reasons.push("insufficient_history");
    return empty();
  }

  const closes = candles.map((c) => c[CLOSE]);
  const vols = candles.map((c) => c[VOLUME]);
  const i = closes.length - 1;

  // EMA
  const emaF = ema(closes, 20);
  const emaS = ema(closes, 50);
  const fastNow = emaF[i];
  const slowNow = emaS[i];
  const fastPrev = emaF[Math.max(0, i - 5)];
  const slopePct = fastNow != null && fastPrev != null && fastPrev !== 0
    ? (fastNow - fastPrev) / fastPrev : 0;

  let stack: EmaFacet["stack"] = "flat";
  if (fastNow != null && slowNow != null) {
    if (fastNow > slowNow && closes[i] > fastNow) stack = "up";
    else if (fastNow < slowNow && closes[i] < fastNow) stack = "down";
    else stack = "mixed";
  }
  if (stack === "up") reasons.push("ema_stack_up");
  if (stack === "down") reasons.push("ema_stack_down");
  if (slopePct > 0.002) reasons.push("ema_slope_up");
  else if (slopePct < -0.002) reasons.push("ema_slope_down");
  else reasons.push("ema_slope_flat");

  // Momentum
  const roc = closes[i - 10] > 0 ? (closes[i] - closes[i - 10]) / closes[i - 10] : 0;
  const rsi14 = rsi(closes, 14);
  const rsiNorm = rsi14 == null ? 0 : (rsi14 - 50) / 50;
  const momentumNorm = clamp((roc * 10 + rsiNorm) / 2, -1, 1);
  if (momentumNorm > 0.15) reasons.push("momentum_bull");
  else if (momentumNorm < -0.15) reasons.push("momentum_bear");
  else reasons.push("momentum_flat");

  // Volume
  const vSlice = vols.slice(-50);
  const vSorted = [...vSlice].sort((a, b) => a - b);
  const vMedian = vSorted[Math.floor(vSorted.length / 2)] || 0;
  const vLast = vols[i];
  const vRatio = vMedian > 0 ? vLast / vMedian : 0;
  if (vRatio >= 1.5) reasons.push("volume_expansion");
  else if (vRatio > 0 && vRatio <= 0.7) reasons.push("volume_contraction");

  // Volatility
  const atr = wilderAtr(candles, 14);
  const atrNow = atr[i];
  const price = closes[i];
  const atrPct = atrNow != null && price > 0 ? atrNow / price : null;
  const atrRoll = atr.slice(-100).filter((v): v is number => v != null && v > 0)
    .map((v) => v / price);
  let atrPercentile: number | null = null;
  let regime: VolatilityFacet["regime"] = "normal";
  if (atrPct != null && atrRoll.length >= 20) {
    const sorted = [...atrRoll].sort((a, b) => a - b);
    let rank = 0;
    for (const v of sorted) { if (v <= atrPct) rank++; else break; }
    atrPercentile = rank / sorted.length;
    if (atrPercentile >= 0.8) { regime = "expansion"; reasons.push("atr_expansion"); }
    else if (atrPercentile <= 0.2) { regime = "contraction"; reasons.push("atr_contraction"); }
    else reasons.push("atr_normal");
  }

  // Structure
  const structure = detectStructure(candles);
  if (structure.hh && structure.hl) reasons.push("structure_hh_hl");
  if (structure.lh && structure.ll) reasons.push("structure_lh_ll");
  if (structure.range) reasons.push("structure_range");
  if (structure.bos === "up") reasons.push("bos_up");
  if (structure.bos === "down") reasons.push("bos_down");
  if (structure.choch === "up") reasons.push("choch_up");
  if (structure.choch === "down") reasons.push("choch_down");
  if (structure.failed_breakout === "up") reasons.push("failed_breakout_up");
  if (structure.failed_breakout === "down") reasons.push("failed_breakout_down");

  // Score composition
  let score = 0;
  if (stack === "up") score += 0.30;
  if (stack === "down") score -= 0.30;
  score += clamp(slopePct * 15, -0.20, 0.20);
  if (structure.bos === "up") score += 0.20;
  if (structure.bos === "down") score -= 0.20;
  if (structure.choch === "up") score += 0.10;
  if (structure.choch === "down") score -= 0.10;
  if (structure.failed_breakout === "up") score -= 0.10; // sweep up → fade
  if (structure.failed_breakout === "down") score += 0.10;
  score += clamp(momentumNorm * 0.20, -0.20, 0.20);
  if (vRatio >= 1.5 && score !== 0) score += Math.sign(score) * 0.05;
  score = clamp(score, -1, 1);

  const direction: EvidenceDirection = score > 0.15 ? "long" : score < -0.15 ? "short" : "none";

  return {
    symbol,
    timeframe,
    direction,
    score,
    reason_codes: reasons,
    structure,
    ema: { fast: fastNow, slow: slowNow, stack, slope_pct: slopePct },
    momentum: { roc_pct: roc, rsi14, norm: momentumNorm },
    volume: { last: vLast, median50: vMedian, ratio: vRatio },
    volatility: { atr_pct: atrPct, atr_percentile: atrPercentile, regime },
    data_quality: dq,
    evidence_schema_version: EVIDENCE_SCHEMA_VERSION,
    rules_version: RULES_VERSION,
  };
}
