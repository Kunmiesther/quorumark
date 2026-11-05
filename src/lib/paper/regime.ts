/**
 * REGIME CLASSIFIER — decides which strategy to ARM per symbol.
 *
 * PURE, additive. Nothing imports it yet; the engine router (a later PR) will
 * call `classifyRegime` to route new entries: high_vol → Hunter, trend →
 * Accumulator, neutral → Sniper.
 *
 * DESIGN (see the strategy discussion):
 *  - This is the SLOW, STABLE layer. It does NOT protect open trades — each
 *    strategy's own stop does that, on the candle the market actually turns.
 *    Its only job is to pick the right tool for the NEXT entry.
 *  - Robust neutral detection combines three signals, not one EMA slope:
 *      • ADX (Wilder)         — is there a directional trend at all?
 *      • Efficiency Ratio     — is price moving cleanly or just chopping?
 *      • ATR% (volatility)    — is this a high-volatility regime (Hunter)?
 *  - HYSTERESIS + CONFIRMATION prevent whipsaw:
 *      • asymmetric ADX thresholds (enter trend above adxEnter, leave only
 *        below adxExit) so the state can't flip-flop around one line;
 *      • a candidate regime must persist `confirmCandles` bars before it
 *        commits.
 *
 * Reuses `signal.ts` `wilderAtrSeries` — no per-module ATR reimplementation.
 *
 * Thresholds are CONFIG with documented defaults, not hidden magic — tune and
 * validate them against real regime labels before trusting the routing.
 */
import { wilderAtrSeries, HIGH, LOW, CLOSE, type Candle } from "./signal";

export type Regime = "trend" | "neutral" | "high_vol";

export interface RegimeConfig {
  adxPeriod: number;
  erWindow: number;
  /** Enter TREND when ADX crosses above this. */
  adxEnter: number;
  /** Leave TREND only when ADX falls below this (< adxEnter → hysteresis). */
  adxExit: number;
  /** TREND also requires clean directional movement (efficiency ratio). */
  erEnter: number;
  /** Enter HIGH_VOL when ATR/price crosses above this (≈ Scout HUNTER_VOL_FLOOR). */
  volEnterAtrPct: number;
  /** Leave HIGH_VOL only when ATR/price falls below this (< volEnter → hysteresis). */
  volExitAtrPct: number;
  /** A new candidate regime must hold this many candles before it commits. */
  confirmCandles: number;
}

export const DEFAULT_REGIME_CONFIG: RegimeConfig = {
  adxPeriod: 14,
  erWindow: 20,
  adxEnter: 25,
  adxExit: 20,
  erEnter: 0.30,
  // Scout's HUNTER_VOL_FLOOR (55 on a 0..100 scale where 100 = 2% ATR/price)
  // ≈ 1.1% ATR/price. Exit a touch lower for hysteresis.
  volEnterAtrPct: 0.011,
  volExitAtrPct: 0.009,
  confirmCandles: 3,
};

// ─── ADX (Wilder) ───────────────────────────────────────────────────────────
/**
 * Wilder ADX series. `adx[i]` is null until enough bars exist (~2×period).
 * +DM/-DM/TR are Wilder-smoothed; DX = 100·|+DI−−DI|/(+DI+−DI); ADX = Wilder
 * smoothing of DX.
 */
export function adxSeries(candles: Candle[], period = 14): (number | null)[] {
  const n = candles.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < 2 * period + 1) return out;

  const plusDM: number[] = new Array(n).fill(0);
  const minusDM: number[] = new Array(n).fill(0);
  const tr: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i][HIGH] - candles[i - 1][HIGH];
    const down = candles[i - 1][LOW] - candles[i][LOW];
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
    const h = candles[i][HIGH];
    const l = candles[i][LOW];
    const pc = candles[i - 1][CLOSE];
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }

  // Wilder-smoothed sums seeded with the first `period` values (indices 1..period).
  let smTr = 0, smPlus = 0, smMinus = 0;
  for (let i = 1; i <= period; i++) { smTr += tr[i]; smPlus += plusDM[i]; smMinus += minusDM[i]; }

  const dx: (number | null)[] = new Array(n).fill(null);
  const computeDx = () => {
    const pdi = smTr === 0 ? 0 : 100 * (smPlus / smTr);
    const mdi = smTr === 0 ? 0 : 100 * (smMinus / smTr);
    const denom = pdi + mdi;
    return denom === 0 ? 0 : 100 * (Math.abs(pdi - mdi) / denom);
  };
  dx[period] = computeDx();
  for (let i = period + 1; i < n; i++) {
    smTr = smTr - smTr / period + tr[i];
    smPlus = smPlus - smPlus / period + plusDM[i];
    smMinus = smMinus - smMinus / period + minusDM[i];
    dx[i] = computeDx();
  }

  // ADX = Wilder smoothing of DX, seeded at index 2*period with the mean of
  // DX over [period+1 .. 2*period].
  const seedEnd = 2 * period;
  if (seedEnd >= n) return out;
  let adx = 0;
  for (let i = period + 1; i <= seedEnd; i++) adx += dx[i] as number;
  adx /= period;
  out[seedEnd] = adx;
  for (let i = seedEnd + 1; i < n; i++) {
    adx = (adx * (period - 1) + (dx[i] as number)) / period;
    out[i] = adx;
  }
  return out;
}

// ─── Kaufman efficiency ratio ───────────────────────────────────────────────
/**
 * ER[i] = |close[i] − close[i−w]| / Σ|close[k] − close[k−1]| over the window.
 * 1 = perfectly directional, ~0 = pure chop. Null until the window is full or
 * when the path length is 0.
 */
export function efficiencyRatioSeries(candles: Candle[], window = 20): (number | null)[] {
  const n = candles.length;
  const out: (number | null)[] = new Array(n).fill(null);
  for (let i = window; i < n; i++) {
    const net = Math.abs(candles[i][CLOSE] - candles[i - window][CLOSE]);
    let path = 0;
    for (let k = i - window + 1; k <= i; k++) path += Math.abs(candles[k][CLOSE] - candles[k - 1][CLOSE]);
    out[i] = path === 0 ? null : net / path;
  }
  return out;
}

// ─── classifier ─────────────────────────────────────────────────────────────
export interface RegimeResult {
  /** Committed regime at the newest candle (null until enough data). */
  regime: Regime | null;
  adx: number | null;
  efficiencyRatio: number | null;
  atrPct: number | null;
  /** A candidate regime awaiting confirmation, if any. */
  pending: Regime | null;
  pendingCount: number;
  /**
   * How many candles the committed regime has held its current value at the
   * newest bar (>= 1 while committed; 0 when regime is null). Used by
   * routing.ts to split `trend` into vanguard (fresh) vs accumulator (aged).
   * Counted from the hysteresis-confirmed commit point in classifyRegimeSeries.
   */
  trendAgeCandles: number;
}

/** What regime the metrics point to RIGHT NOW, applying hysteresis relative to
 * the currently-committed regime. */
function desiredRegime(
  current: Regime | null, adx: number, er: number, atrPct: number, cfg: RegimeConfig,
): Regime {
  // Volatility takes precedence, with its own hysteresis band.
  if (current === "high_vol") {
    if (atrPct >= cfg.volExitAtrPct) return "high_vol";
  } else if (atrPct >= cfg.volEnterAtrPct) {
    return "high_vol";
  }
  // Trend vs neutral, with ADX hysteresis.
  if (current === "trend") {
    return adx >= cfg.adxExit ? "trend" : "neutral";
  }
  return adx >= cfg.adxEnter && er >= cfg.erEnter ? "trend" : "neutral";
}

/**
 * Walk the series forward maintaining a committed regime with hysteresis and
 * an N-candle confirmation delay. Deterministic from candles alone (no
 * external state), so it is safe to recompute every tick.
 */
export function classifyRegimeSeries(
  candles: Candle[], cfg: RegimeConfig = DEFAULT_REGIME_CONFIG,
): { states: (Regime | null)[]; adx: (number | null)[]; er: (number | null)[] } {
  const n = candles.length;
  const adx = adxSeries(candles, cfg.adxPeriod);
  const er = efficiencyRatioSeries(candles, cfg.erWindow);
  const atr = wilderAtrSeries(candles);

  const states: (Regime | null)[] = new Array(n).fill(null);
  let current: Regime | null = null;
  let pending: Regime | null = null;
  let pendingCount = 0;

  for (let i = 0; i < n; i++) {
    const a = adx[i];
    const e = er[i];
    const at = atr[i];
    const close = candles[i][CLOSE];
    const atrPct = at != null && close > 0 ? at / close : null;
    if (a == null || e == null || atrPct == null) {
      states[i] = current;
      continue;
    }
    const desired = desiredRegime(current, a, e, atrPct, cfg);
    if (current === null) {
      // Seed immediately — no confirmation needed for the first classification.
      current = desired;
      pending = null;
      pendingCount = 0;
    } else if (desired === current) {
      pending = null;
      pendingCount = 0;
    } else {
      if (desired === pending) pendingCount++;
      else { pending = desired; pendingCount = 1; }
      if (pendingCount >= cfg.confirmCandles) {
        current = desired;
        pending = null;
        pendingCount = 0;
      }
    }
    states[i] = current;
  }
  return { states, adx, er };
}

/** Regime + supporting metrics at the NEWEST candle. */
export function classifyRegime(
  candles: Candle[], cfg: RegimeConfig = DEFAULT_REGIME_CONFIG,
): RegimeResult {
  const n = candles.length;
  const { states, adx, er } = classifyRegimeSeries(candles, cfg);
  const atr = wilderAtrSeries(candles);
  const i = n - 1;
  if (i < 0) {
    return { regime: null, adx: null, efficiencyRatio: null, atrPct: null, pending: null, pendingCount: 0, trendAgeCandles: 0 };
  }
  const at = atr[i];
  const close = candles[i][CLOSE];
  // Count trailing bars whose committed state equals the newest committed
  // state — the "age" of the currently-committed regime at the newest bar.
  const newest = states[i];
  let age = 0;
  if (newest != null) {
    for (let k = i; k >= 0 && states[k] === newest; k--) age++;
  }
  return {
    regime: newest,
    adx: adx[i],
    efficiencyRatio: er[i],
    atrPct: at != null && close > 0 ? at / close : null,
    pending: null,
    pendingCount: 0,
    trendAgeCandles: age,
  };
}
