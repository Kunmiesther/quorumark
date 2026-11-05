/**
 * PURE per-symbol signal derivation for a committee cycle.
 *
 * Turns a plain OHLCV series into the deterministic facts the strategists are
 * asked about: proposed direction, momentum, structure quality, realized
 * volatility and a first-pass entry / invalidation / TP geometry.
 *
 * AUTHORITY: NONE. No I/O, no Supabase, no venue calls, no execution. Every
 * output is a function of the candles that were passed in, so a cycle can be
 * replayed exactly from persisted evidence.
 */

export type OHLCV = [number, number, number, number, number, number]; // ts,o,h,l,c,v

const TS = 0,
  HIGH = 2,
  LOW = 3,
  CLOSE = 4,
  VOLUME = 5;

export type CycleDirection = "long" | "short";

export interface CycleSignal {
  /** Deterministic side proposal. `null` = no directional read, skip symbol. */
  direction: CycleDirection | null;
  /** 0..1 normalized trend strength. */
  momentum: number;
  /** 0..1 market-structure quality (clean swings, close near the extreme). */
  structure: number;
  /** Realized volatility over the window, percent of price (ATR-based). */
  volatilityPct: number;
  /** Close of the last COMPLETED candle. */
  lastClose: number;
  /** ms epoch of the last completed candle. */
  candleCloseMs: number;
  entry: number;
  invalidation: number;
  tpLevels: number[];
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
}

function ema(values: readonly number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let acc = values[0];
  for (let i = 1; i < values.length; i++) acc = values[i] * k + acc * (1 - k);
  return acc;
}

function atr(candles: readonly OHLCV[], period: number): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const hi = candles[i][HIGH];
    const lo = candles[i][LOW];
    const pc = candles[i - 1][CLOSE];
    trs.push(Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc)));
  }
  const slice = trs.slice(-period);
  if (slice.length === 0) return 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** Minimum candles required before a symbol may be proposed at all. */
export const MIN_CANDLES = 40;

/** Momentum below this is treated as a directionless tape. */
export const MIN_MOMENTUM = 0.08;

/**
 * Derive the deterministic read for one symbol. Returns `direction: null`
 * when the series is too short or the tape has no usable directional bias —
 * the caller must then skip the symbol rather than invent a side.
 */
export function deriveCycleSignal(
  candles: readonly OHLCV[],
  intervalMs = 15 * 60_000,
): CycleSignal | null {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  if (!Array.isArray(candles) || candles.length < MIN_CANDLES) return null;
  const window = candles.slice(-120);
  const closes = window.map((c) => c[CLOSE]);
  const highs = window.map((c) => c[HIGH]);
  const lows = window.map((c) => c[LOW]);
  const volumes = window.map((c) => c[VOLUME]);
  const last = window[window.length - 1];
  const lastClose = last[CLOSE];
  if (!Number.isFinite(lastClose) || lastClose <= 0) return null;

  const fast = ema(closes.slice(-21), 9);
  const slow = ema(closes.slice(-60), 21);
  const atrAbs = atr(window, 14);
  const volatilityPct = (atrAbs / lastClose) * 100;

  // Momentum: EMA separation expressed in ATR units, saturating at 2 ATR.
  const sep = fast - slow;
  const sepAtr = atrAbs > 0 ? Math.abs(sep) / atrAbs : 0;
  const momentum = clamp01(sepAtr / 2);
  if (momentum < MIN_MOMENTUM) return null;

  const direction: CycleDirection = sep >= 0 ? "long" : "short";

  // Structure: how decisively the last close sits inside the recent range in
  // the proposed direction, blended with swing cleanliness.
  const hi = Math.max(...highs.slice(-40));
  const lo = Math.min(...lows.slice(-40));
  const span = hi - lo;
  const pos = span > 0 ? (lastClose - lo) / span : 0.5;
  const directional = direction === "long" ? pos : 1 - pos;
  const bodyRatio =
    span > 0
      ? clamp01(
          Math.abs(closes[closes.length - 1] - closes[Math.max(0, closes.length - 10)]) / span,
        )
      : 0;
  const structure = clamp01(0.7 * directional + 0.3 * bodyRatio);

  const entry = lastClose;
  const invalidation = direction === "long" ? entry - 1.5 * atrAbs : entry + 1.5 * atrAbs;
  const tpLevels =
    direction === "long"
      ? [entry + 1 * atrAbs, entry + 2 * atrAbs, entry + 3 * atrAbs]
      : [entry - 1 * atrAbs, entry - 2 * atrAbs, entry - 3 * atrAbs];

  return {
    direction,
    momentum,
    structure,
    volatilityPct,
    lastClose,
    // Venue OHLCV timestamps denote OPEN time; freshness uses the completed close.
    candleCloseMs: Number(last[TS]) + intervalMs,
    entry,
    invalidation,
    tpLevels,
    closes,
    highs,
    lows,
    volumes,
  };
}
