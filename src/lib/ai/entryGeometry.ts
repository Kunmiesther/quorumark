/**
 * STRUCTURE-AWARE ENTRY GEOMETRY — pure, deterministic, no I/O.
 *
 * Replaces the old "market at last close, stop at ±1.5 ATR" geometry that was
 * proven to propose late entries at the end of an extended 5m leg and then
 * anchor invalidation to nothing but volatility.
 *
 * What this module decides:
 *   - whether the tape is EXTENDED (chasing) or still entry-able at market;
 *   - where a structure-aware pullback LIMIT entry sits (nearest valid pivot,
 *     liquidity retest, fair-value-gap edge, or a bounded ATR retracement);
 *   - a structure-anchored invalidation beyond the relevant swing/pivot plus a
 *     volatility buffer, clamped between a market-noise floor and an account
 *     risk-distance ceiling;
 *   - position size recomputed from the REAL stop distance so account risk is
 *     fixed regardless of how wide the structural stop turned out to be;
 *   - a deterministic expiry for unfilled limit entries.
 *
 * AUTHORITY: NONE. Pure functions of the numbers passed in. Nothing here
 * opens, sizes, cancels or closes anything on a venue.
 */

export type Direction = "long" | "short";
export type EntryType = "market" | "limit";

export const GEOMETRY_VERSION = "geometry.v2";

export const GEOMETRY_POLICY = {
  /** Distance from the anchor pivot, in ATR, above which a market entry is
   *  considered "chasing" and must be converted to a pullback limit. */
  maxExtensionAtr: 1.6,
  /** Continuation override: an extended tape may still take market entry when
   *  momentum AND structure are both at least this strong and extension is
   *  below `hardExtensionAtr`. */
  continuationMomentum: 0.62,
  continuationStructure: 0.62,
  /** Beyond this extension nothing may be entered at market, ever. */
  hardExtensionAtr: 2.4,
  /** Bounded retracement band for the fallback limit entry, in ATR. */
  minRetraceAtr: 0.4,
  maxRetraceAtr: 1.2,
  /** Volatility buffer added beyond the structural pivot for the stop. */
  stopBufferAtr: 0.35,
  /** Market-noise floor for stop distance, in ATR of the cycle timeframe. */
  minStopAtr: 0.6,
  /** Ceiling for stop distance, in ATR. Wider than this and the setup is
   *  rejected rather than sized down into meaninglessness. */
  maxStopAtr: 3.0,
  /** Spread multiple the stop must clear, on top of the ATR floor. */
  minStopSpreadMultiple: 3,
  /** Minimum reward:risk to the first TP for the setup to be worth taking. */
  minRewardRisk: 1.0,
  /** Unfilled limit entries expire after this many 5m candles. */
  expiryCandles: 3,
  /** Cancel a resting entry if price runs this far away from it, in ATR. */
  runawayAtr: 1.0,
  /** Lookback for swing pivot detection. */
  pivotLookback: 60,
  /** Fractal half-width for a swing to count as a pivot. */
  pivotWidth: 2,
  /** Volume must be at least this fraction of the recent average. */
  minVolumeRatio: 0.5,
} as const;

export const CANDLE_MS = 300_000;

export interface GeometryInput {
  direction: Direction;
  lastClose: number;
  candleCloseMs: number;
  atrAbs: number;
  spreadBps: number | null;
  momentum: number;
  structure: number;
  highs: readonly number[];
  lows: readonly number[];
  closes: readonly number[];
  volumes: readonly number[];
  tickSize?: number | null;
}

export interface EntryPlan {
  version: string;
  direction: Direction;
  entryType: EntryType;
  entry: number;
  /** Acceptance band around a limit entry (null for market). */
  entryZone: { low: number; high: number } | null;
  /** Structure level the entry is anchored to, if any. */
  entryAnchor: "pivot" | "fvg" | "atr_retrace" | "market" | null;
  stop: number;
  stopDistance: number;
  stopAtrMultiple: number;
  /** Level the stop was anchored beyond. */
  stopAnchor: "swing" | "noise_floor" | null;
  tpLevels: number[];
  rewardRisk: number;
  extensionAtr: number;
  extended: boolean;
  volumeRatio: number;
  expiresAtMs: number | null;
  /** Absolute price beyond which a resting entry is abandoned. */
  runawayPrice: number | null;
  rejectReason: string | null;
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function roundToTick(price: number, tick: number | null | undefined, dir: "up" | "down"): number {
  if (!finite(tick) || tick <= 0) return price;
  const q = price / tick;
  const r = dir === "up" ? Math.ceil(q - 1e-9) : Math.floor(q + 1e-9);
  return Number((r * tick).toFixed(10));
}

/** Fractal swing pivots. Returns prices, most recent last. */
export function findPivots(
  values: readonly number[],
  kind: "high" | "low",
  width = GEOMETRY_POLICY.pivotWidth,
): Array<{ index: number; price: number }> {
  const out: Array<{ index: number; price: number }> = [];
  for (let i = width; i < values.length - width; i++) {
    let ok = true;
    for (let j = i - width; j <= i + width; j++) {
      if (j === i) continue;
      if (kind === "high" ? values[j] >= values[i] : values[j] <= values[i]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push({ index: i, price: values[i] });
  }
  return out;
}

/**
 * Most recent unfilled fair-value gap edge in the direction of travel.
 * Bullish FVG: low[i] > high[i-2]; the gap's lower edge (high[i-2]) is the
 * retest level a long wants to buy back into.
 */
export function findFvgRetest(
  highs: readonly number[],
  lows: readonly number[],
  direction: Direction,
  lastClose: number,
): number | null {
  for (let i = highs.length - 1; i >= 2; i--) {
    if (direction === "long" && lows[i] > highs[i - 2]) {
      const edge = highs[i - 2];
      if (edge < lastClose) return edge;
    }
    if (direction === "short" && highs[i] < lows[i - 2]) {
      const edge = lows[i - 2];
      if (edge > lastClose) return edge;
    }
  }
  return null;
}

/**
 * Build the full entry/invalidation geometry for one candidate. Returns a plan
 * with `rejectReason` set (and `entryType: "market"` placeholder values) when
 * no geometry can satisfy both market noise and account risk.
 */
export function buildEntryPlan(input: GeometryInput): EntryPlan {
  const {
    direction, lastClose, candleCloseMs, atrAbs, momentum, structure,
    highs, lows, volumes, tickSize,
  } = input;
  const long = direction === "long";
  const sign = long ? 1 : -1;
  const spreadBps = finite(input.spreadBps) ? Math.max(0, input.spreadBps) : 0;

  const base: EntryPlan = {
    version: GEOMETRY_VERSION,
    direction,
    entryType: "market",
    entry: lastClose,
    entryZone: null,
    entryAnchor: null,
    stop: lastClose,
    stopDistance: 0,
    stopAtrMultiple: 0,
    stopAnchor: null,
    tpLevels: [],
    rewardRisk: 0,
    extensionAtr: 0,
    extended: false,
    volumeRatio: 0,
    expiresAtMs: null,
    runawayPrice: null,
    rejectReason: null,
  };

  if (!finite(lastClose) || lastClose <= 0 || !finite(atrAbs) || atrAbs <= 0) {
    return { ...base, rejectReason: "invalid_geometry_inputs" };
  }

  // ---- Participation: a retest needs someone on the other side. ----------
  const recentVol = volumes.slice(-3);
  const avgVol = volumes.slice(-30).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(30, volumes.length));
  const volumeRatio = avgVol > 0 ? recentVol.reduce((a, b) => a + b, 0) / (recentVol.length * avgVol) : 0;
  if (volumeRatio < GEOMETRY_POLICY.minVolumeRatio) {
    return { ...base, volumeRatio, rejectReason: "insufficient_participation" };
  }

  // ---- Anchors -----------------------------------------------------------
  const window = GEOMETRY_POLICY.pivotLookback;
  const hs = highs.slice(-window);
  const ls = lows.slice(-window);
  // The pivot the leg started from (behind price) and the pivot ahead of it.
  const behindPivots = long ? findPivots(ls, "low") : findPivots(hs, "high");
  const behind = behindPivots.length > 0 ? behindPivots[behindPivots.length - 1].price : (long ? Math.min(...ls) : Math.max(...hs));

  const extensionAtr = Math.abs(lastClose - behind) / atrAbs;

  // ---- Stop: beyond the structural pivot + volatility buffer -------------
  const structuralStop = behind - sign * GEOMETRY_POLICY.stopBufferAtr * atrAbs;
  let stopDistance = Math.abs(lastClose - structuralStop);
  let stopAnchor: EntryPlan["stopAnchor"] = "swing";

  const noiseFloor = Math.max(
    GEOMETRY_POLICY.minStopAtr * atrAbs,
    (spreadBps / 10_000) * lastClose * GEOMETRY_POLICY.minStopSpreadMultiple,
  );
  if (stopDistance < noiseFloor) {
    stopDistance = noiseFloor;
    stopAnchor = "noise_floor";
  }

  const ceiling = GEOMETRY_POLICY.maxStopAtr * atrAbs;

  // ---- Entry: market only when not extended (or strong continuation) -----
  const extended = extensionAtr > GEOMETRY_POLICY.maxExtensionAtr;
  const continuation =
    momentum >= GEOMETRY_POLICY.continuationMomentum &&
    structure >= GEOMETRY_POLICY.continuationStructure &&
    extensionAtr < GEOMETRY_POLICY.hardExtensionAtr;

  let entryType: EntryType = "market";
  let entry = lastClose;
  let entryAnchor: EntryPlan["entryAnchor"] = "market";
  let entryZone: EntryPlan["entryZone"] = null;

  if (extended && !continuation) {
    entryType = "limit";
    const fvg = findFvgRetest(highs, lows, direction, lastClose);
    // Nearest pivot BEHIND price in the retrace direction.
    const retestCandidates = (long ? findPivots(hs, "high") : findPivots(ls, "low"))
      .map((p) => p.price)
      .filter((p) => (long ? p < lastClose : p > lastClose));

    const minR = lastClose - sign * GEOMETRY_POLICY.minRetraceAtr * atrAbs;
    const maxR = lastClose - sign * GEOMETRY_POLICY.maxRetraceAtr * atrAbs;
    const withinBand = (p: number) => (long ? p <= minR && p >= maxR : p >= minR && p <= maxR);

    const pivotRetest = retestCandidates.filter(withinBand).sort((a, b) => (long ? b - a : a - b))[0];
    if (finite(fvg) && withinBand(fvg)) {
      entry = fvg;
      entryAnchor = "fvg";
    } else if (finite(pivotRetest)) {
      entry = pivotRetest;
      entryAnchor = "pivot";
    } else {
      entry = lastClose - sign * ((GEOMETRY_POLICY.minRetraceAtr + GEOMETRY_POLICY.maxRetraceAtr) / 2) * atrAbs;
      entryAnchor = "atr_retrace";
    }
    entry = roundToTick(entry, tickSize, long ? "down" : "up");
    const half = 0.15 * atrAbs;
    entryZone = { low: entry - half, high: entry + half };
  }

  // ---- Stop measured from the ACTUAL entry, not from last close. ---------
  stopDistance = Math.abs(entry - structuralStop);
  stopAnchor = "swing";
  if (stopDistance < noiseFloor) {
    stopDistance = noiseFloor;
    stopAnchor = "noise_floor";
  }
  if (stopDistance > ceiling) {
    return {
      ...base,
      volumeRatio,
      extensionAtr,
      extended,
      entryType,
      entry,
      entryAnchor,
      entryZone,
      stopDistance,
      stopAtrMultiple: stopDistance / atrAbs,
      stopAnchor: "swing",
      rejectReason: "stop_distance_exceeds_ceiling",
    };
  }
  let stop = roundToTick(entry - sign * stopDistance, tickSize, long ? "down" : "up");
  stopDistance = Math.abs(entry - stop);


  if (stopDistance <= 0) return { ...base, volumeRatio, extensionAtr, rejectReason: "degenerate_stop" };
  if (stopDistance > ceiling) {
    return { ...base, volumeRatio, extensionAtr, stopDistance, stopAtrMultiple: stopDistance / atrAbs, rejectReason: "stop_distance_exceeds_ceiling" };
  }

  // ---- Targets scale with the real risk distance, not a fixed ATR ladder -
  const tpLevels = [1, 2, 3].map((r) => Number((entry + sign * r * stopDistance).toFixed(10)));
  const rewardRisk = Math.abs(tpLevels[0] - entry) / stopDistance;
  if (rewardRisk < GEOMETRY_POLICY.minRewardRisk) {
    return { ...base, volumeRatio, extensionAtr, stopDistance, rejectReason: "reward_risk_too_low" };
  }

  const expiresAtMs =
    entryType === "limit" ? candleCloseMs + GEOMETRY_POLICY.expiryCandles * CANDLE_MS : null;
  const runawayPrice =
    entryType === "limit" ? entry + sign * GEOMETRY_POLICY.runawayAtr * atrAbs : null;

  return {
    version: GEOMETRY_VERSION,
    direction,
    entryType,
    entry,
    entryZone,
    entryAnchor,
    stop,
    stopDistance,
    stopAtrMultiple: stopDistance / atrAbs,
    stopAnchor,
    tpLevels,
    rewardRisk,
    extensionAtr,
    extended,
    volumeRatio,
    expiresAtMs,
    runawayPrice,
    rejectReason: null,
  };
}

export interface RiskSizing {
  riskUsd: number;
  qty: number;
  notionalUsd: number;
  stopDistance: number;
  rejectReason: string | null;
}

/**
 * Size ENTIRELY from the real stop distance so account risk stays fixed.
 * A wider structural stop yields a smaller position — never the same notional
 * with a looser stop.
 */
export function sizeFromRisk(args: {
  equityUsd: number;
  riskPct: number;
  entry: number;
  stopDistance: number;
  maxNotionalUsd?: number;
  stepSize?: number | null;
  minNotionalUsd?: number | null;
}): RiskSizing {
  const { equityUsd, riskPct, entry, stopDistance } = args;
  const empty = { riskUsd: 0, qty: 0, notionalUsd: 0, stopDistance };
  if (!(equityUsd > 0) || !(riskPct > 0) || !(entry > 0) || !(stopDistance > 0)) {
    return { ...empty, rejectReason: "invalid_sizing_inputs" };
  }
  const riskUsd = equityUsd * (riskPct / 100);
  let qty = riskUsd / stopDistance;
  const step = finite(args.stepSize) && args.stepSize! > 0 ? args.stepSize! : null;
  if (step) qty = Math.floor(qty / step + 1e-9) * step;
  let notionalUsd = qty * entry;

  if (finite(args.maxNotionalUsd) && notionalUsd > args.maxNotionalUsd!) {
    qty = args.maxNotionalUsd! / entry;
    if (step) qty = Math.floor(qty / step + 1e-9) * step;
    notionalUsd = qty * entry;
  }
  if (qty <= 0) return { ...empty, rejectReason: "size_rounds_to_zero" };
  if (finite(args.minNotionalUsd) && notionalUsd < args.minNotionalUsd!) {
    return { riskUsd, qty, notionalUsd, stopDistance, rejectReason: "below_min_notional" };
  }
  return { riskUsd, qty, notionalUsd, stopDistance, rejectReason: null };
}
