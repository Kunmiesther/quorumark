/**
 * Scout scoring — pure price / volatility / trend / momentum math.
 * NO news, NO sentiment, NO social. Real inputs only; when an input is
 * missing the corresponding score is null and the UI renders "n/a".
 *
 * Reuses the paper engine's `computeTrend` (EMA-100 + slope) so the Scout's
 * trend view is identical to what the paper engine's trend filter enforces.
 * Read-only: this module never places orders, never touches wallets.
 */

import {
  wilderAtrSeries,
  computeTrend,
  CLOSE,
  type Candle,
  type TrendInfo,
  type TrendState,
} from "@/lib/paper/signal";

export type Direction = "long" | "short" | "neutral";
export type TurtleRec = "hunter" | "accumulator" | "sit-out";

export interface ScoutScores {
  /** 0..100 — ATR% (ATR / price) scaled. Volatility magnitude. */
  volatility: number | null;
  /** 0..100 — |EMA slope| scaled. Trend strength magnitude. */
  trendStrength: number | null;
  /** -100..100 — signed % change over the momentum window. */
  momentum: number | null;
  /** 0..100 — composite "movement" score (how tradeable / active right now). */
  movement: number | null;
  /** UP / DOWN / NEUTRAL from computeTrend. */
  trend: TrendState;
  /** Recommended entry direction. Aligned with trend for Accumulator, follows momentum for Hunter. */
  direction: Direction;
  /** Which turtle fits this regime (or sit-out). */
  recommendation: TurtleRec;
}

export interface ScoutSignal {
  scores: ScoutScores;
  trendInfo: TrendInfo;
  /** Latest price (close of most recent closed candle). */
  price: number | null;
  /** Raw ATR% used for the volatility score. */
  atrPct: number | null;
  /** Raw momentum window used (candles). */
  momentumWindow: number;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

/** How many candles to measure momentum over on 5m data (12 = 1h). */
export const MOMENTUM_WINDOW = 12;

/** ATR% saturation point: 2% ATR/price -> volatility score 100. */
export const ATR_PCT_SATURATION = 0.02;

/** Momentum saturation point: ±3% over the window -> ±100. */
export const MOMENTUM_SATURATION_PCT = 3;

/** Trend-slope saturation point: 1.5% EMA slope over lookback -> strength 100. */
export const TREND_SLOPE_SATURATION = 0.015;

/** Hunter engages above this ATR% (roughly the top of Accumulator territory). */
export const HUNTER_VOL_FLOOR = 55;

/** Composite movement floor — below this, sit out (no edge worth the wallet). */
export const MOVEMENT_FLOOR = 25;

/**
 * Compute the Scout signal for a single symbol from its 5m candles.
 * Pure — no I/O, never throws. Missing inputs surface as null scores.
 */
export function scoutSignal(candles: Candle[]): ScoutSignal {
  const trendInfo = computeTrend(candles);
  const n = candles.length;
  const price = n > 0 ? candles[n - 1][CLOSE] : null;

  // ATR% — realized short-horizon volatility.
  let atrPct: number | null = null;
  if (n >= 15 && price != null && price > 0) {
    const atr = wilderAtrSeries(candles);
    const atrNow = atr[n - 1];
    if (atrNow != null && atrNow > 0) atrPct = atrNow / price;
  }
  const volatility =
    atrPct == null ? null : clamp((atrPct / ATR_PCT_SATURATION) * 100, 0, 100);

  // Trend strength — absolute EMA slope scaled.
  const trendStrength =
    trendInfo.slopePct == null
      ? null
      : clamp((Math.abs(trendInfo.slopePct) / TREND_SLOPE_SATURATION) * 100, 0, 100);

  // Momentum — signed % change over MOMENTUM_WINDOW candles.
  let momentum: number | null = null;
  if (n > MOMENTUM_WINDOW) {
    const then = candles[n - 1 - MOMENTUM_WINDOW][CLOSE];
    const now = candles[n - 1][CLOSE];
    if (then > 0 && Number.isFinite(then) && Number.isFinite(now)) {
      const pct = ((now - then) / then) * 100;
      momentum = clamp((pct / MOMENTUM_SATURATION_PCT) * 100, -100, 100);
    }
  }

  // Composite movement — how ACTIVE the symbol is (unsigned edge).
  // Weighted: volatility 40, trend strength 30, |momentum| 30. All required.
  const movement =
    volatility != null && trendStrength != null && momentum != null
      ? clamp(
          0.4 * volatility + 0.3 * trendStrength + 0.3 * Math.abs(momentum),
          0,
          100,
        )
      : null;

  // Route to a turtle.
  //  - High volatility -> Hunter (not trend-gated; follows momentum sign).
  //  - Clean trend + enough movement -> Accumulator, WITH the trend.
  //  - Otherwise -> sit out.
  let recommendation: TurtleRec = "sit-out";
  let direction: Direction = "neutral";
  if (volatility != null && movement != null && movement >= MOVEMENT_FLOOR) {
    if (volatility >= HUNTER_VOL_FLOOR) {
      recommendation = "hunter";
      // Hunter follows the recent momentum sign; if flat, prefer trend.
      if (momentum != null && Math.abs(momentum) >= 20) {
        direction = momentum > 0 ? "long" : "short";
      } else if (trendInfo.state === "up") direction = "long";
      else if (trendInfo.state === "down") direction = "short";
    } else if (trendInfo.state !== "neutral" && (trendStrength ?? 0) >= 30) {
      recommendation = "accumulator";
      direction = trendInfo.state === "up" ? "long" : "short";
    }
  }

  return {
    scores: {
      volatility,
      trendStrength,
      momentum,
      movement,
      trend: trendInfo.state,
      direction,
      recommendation,
    },
    trendInfo,
    price,
    atrPct,
    momentumWindow: MOMENTUM_WINDOW,
  };
}
