/**
 * SNIPER strategy — range/neutral reversal detection (zone fakeout entry +
 * session-VWAP magnet target).
 *
 * FAITHFUL TypeScript port of `sniper_signal.py` (v2), mirroring the pattern
 * of `signal.ts` / `hunter.ts`. PURE: no I/O, no orders, no wallet access.
 * Entry/exit *bookkeeping* (fills, sizing, size-up) is wired in the engine
 * router (a later PR); this module only DETECTS zones, entries, targets, and
 * invalidations.
 *
 * Reuses `signal.ts` `wilderAtrSeries` / `emaSeries` so ATR and EMA are
 * identical across every strategy — no per-strategy indicator drift.
 *
 * Strategy shape (owner spec, sniper_signal.py):
 *   - Regime: EMA(50) slope over 20 bars, |slope| <= FLAT_PCT ⇒ ranging.
 *   - Zones: 5-candle pivots with an ATR(14) tolerance band (ZONE_ATR_MULT).
 *   - Entry: FAKEOUT-RECLAIM at a zone edge — price wicks BEYOND the zone then
 *     CLOSES back inside; reject wicks deeper than MAX_WICK_ATR_MULT×ATR (a
 *     real breakout, not a fakeout). Stop = just past the fakeout wick.
 *   - Target: session VWAP (reversion magnet, resets 00:00 UTC). On reaching
 *     VWAP, a decisive close through it (continuation) ⇒ size up and ride to
 *     the opposing zone / R-multiple fallback; otherwise exit at VWAP.
 *   - Invalidation: a close beyond the zone (the range level broke).
 *
 * Constants MUST match `sniper_signal.py` exactly.
 */
import {
  wilderAtrSeries, emaSeries,
  TS, HIGH, LOW, CLOSE, VOLUME,
  type Candle,
} from "./signal";

export type SniperDirection = "long" | "short";

import { SNIPER as _S } from "./parityConstants";
// Zone band
export const ATR_PERIOD = _S.atr_period;
export const ZONE_ATR_MULT = _S.zone_atr_mult;
export const PIVOT_LEFT = _S.pivot_left;
export const PIVOT_RIGHT = _S.pivot_right;

// Regime
export const EMA_PERIOD = _S.ema_period;
export const SLOPE_LOOKBACK = _S.slope_lookback;
export const FLAT_PCT = _S.flat_pct;

// Zone freshness (in HTF candles)
export const ZONE_LOOKBACK_HOURS = _S.zone_lookback_hours;

// Fakeout gating
export const MAX_WICK_ATR_MULT = _S.max_wick_atr_mult;
export const FALLBACK_R = _S.fallback_r;

// Continuation gate at VWAP
export const CONT_BODY_FRAC = _S.cont_body_frac;
export const CONT_MIN_ATR_MULT = _S.cont_min_atr_mult;

export const DAY_MS = 86_400_000;

// ─── session VWAP (resets at 00:00 UTC) ─────────────────────────────────────
/**
 * Session VWAP inclusive of candle t. Requires real volume (>0); a session
 * with zero cumulative volume yields null (matches sniper_signal.py).
 */
export function sessionVwapSeries(ltf: Candle[]): (number | null)[] {
  const n = ltf.length;
  const out: (number | null)[] = new Array(n).fill(null);
  let curDay = -1;
  let cumPv = 0;
  let cumV = 0;
  for (let i = 0; i < n; i++) {
    const c = ltf[i];
    const day = Math.floor(c[TS] / DAY_MS);
    if (day !== curDay) {
      curDay = day;
      cumPv = 0;
      cumV = 0;
    }
    const hi = c[HIGH];
    const lo = c[LOW];
    const cl = c[CLOSE];
    const v = c.length > VOLUME ? c[VOLUME] : 0;
    const tp = (hi + lo + cl) / 3;
    cumPv += tp * v;
    cumV += v;
    if (cumV > 0) out[i] = cumPv / cumV;
  }
  return out;
}

// ─── zones ──────────────────────────────────────────────────────────────────
export interface Zone {
  kind: "supply" | "demand";
  pivotIndex: number;
  pivotTs: number;
  level: number;
  lower: number;
  upper: number;
  atr: number;
}

/** 5-candle pivots with an ATR tolerance band. Mirrors find_zones. */
export function findZones(htf: Candle[], tick: number): Zone[] {
  const atr = wilderAtrSeries(htf);
  const out: Zone[] = [];
  const n = htf.length;
  for (let i = PIVOT_LEFT; i < n - PIVOT_RIGHT; i++) {
    const c = htf[i];
    const hi = c[HIGH];
    const lo = c[LOW];
    const nb = [htf[i - 2], htf[i - 1], htf[i + 1], htf[i + 2]];
    const a = i + PIVOT_RIGHT < atr.length ? atr[i + PIVOT_RIGHT] : null;
    if (a == null) continue;
    const tol = Math.max(tick, ZONE_ATR_MULT * a);
    if (nb.every((x) => hi > x[HIGH])) {
      out.push({ kind: "supply", pivotIndex: i, pivotTs: c[TS], level: hi, lower: hi - tol, upper: hi + tol, atr: a });
    }
    if (nb.every((x) => lo < x[LOW])) {
      out.push({ kind: "demand", pivotIndex: i, pivotTs: c[TS], level: lo, lower: lo - tol, upper: lo + tol, atr: a });
    }
  }
  return out;
}

// ─── regime ─────────────────────────────────────────────────────────────────
/**
 * True/false = ranging/trending at index i by EMA-slope magnitude; null when
 * undefined. Mirrors is_ranging_at. NOTE: this is the module's *own* simple
 * range test; the router uses the richer `regime.ts` classifier (ADX +
 * efficiency ratio + hysteresis) to decide which strategy to arm.
 */
export function isRangingAt(
  htfEma: (number | null)[], i: number,
  lookback: number = SLOPE_LOOKBACK, flatPct: number = FLAT_PCT,
): boolean | null {
  if (i - lookback < 0) return null;
  const a = htfEma[i];
  const b = htfEma[i - lookback];
  if (a == null || b == null || b === 0) return null;
  return Math.abs((a - b) / b) <= flatPct;
}

/** Convenience: EMA(50) series for the regime test. */
export function regimeEma(htf: Candle[]): (number | null)[] {
  return emaSeries(htf, EMA_PERIOD);
}

// ─── zone selection ─────────────────────────────────────────────────────────
export function activeZonesAt(zones: Zone[], htfIndexNow: number): Zone[] {
  const cutoff = htfIndexNow - ZONE_LOOKBACK_HOURS;
  return zones.filter(
    (z) => z.pivotIndex + PIVOT_RIGHT <= htfIndexNow && z.pivotIndex >= cutoff,
  );
}

/** Nearest opposing zone in the trade's favor — the "ride" target after a
 * confirmed VWAP continuation. Mirrors opposing_zone_target. */
export function opposingZoneTarget(
  zones: Zone[], direction: SniperDirection, entryPx: number, htfIndexNow: number,
): Zone | null {
  const cutoff = htfIndexNow - ZONE_LOOKBACK_HOURS;
  const cand: Zone[] = [];
  for (const z of zones) {
    if (z.pivotIndex + PIVOT_RIGHT > htfIndexNow) continue;
    if (z.pivotIndex < cutoff) continue;
    if (direction === "long" && z.kind === "supply" && z.level > entryPx) cand.push(z);
    else if (direction === "short" && z.kind === "demand" && z.level < entryPx) cand.push(z);
  }
  if (!cand.length) return null;
  return direction === "long"
    ? cand.reduce((a, b) => (a.level <= b.level ? a : b)) // nearest above
    : cand.reduce((a, b) => (a.level >= b.level ? a : b)); // nearest below
}

// ─── entry ──────────────────────────────────────────────────────────────────
export interface FakeoutEntry {
  direction: SniperDirection;
  /** Entry price (candle close). */
  entry: number;
  /** Stop just past the fakeout wick. */
  stop: number;
  /** The wick extreme that defines the stop. */
  wick: number;
  /** Whether the fakeout filter (wick-beyond + reclaim) produced this. */
  filtered: boolean;
}

/**
 * Fakeout-reclaim entry at a zone edge. Returns an entry or null. Mirrors
 * detect_fakeout_entry exactly:
 *  - demand (support) ⇒ long; supply (resistance) ⇒ short.
 *  - reject wicks deeper than MAX_WICK_ATR_MULT×ATR (a real breakout).
 *  - with the filter ON: require wick-beyond AND close-reclaimed-inside.
 */
export function detectFakeoutEntry(
  ltfCandle: Candle, zone: Zone, tick: number, useFakeoutFilter = true,
): FakeoutEntry | null {
  const hi = ltfCandle[HIGH];
  const lo = ltfCandle[LOW];
  const cl = ltfCandle[CLOSE];

  if (zone.kind === "demand") {
    const wickBeyond = lo < zone.lower;
    const reclaim = cl >= zone.lower;
    if (wickBeyond && zone.lower - lo > MAX_WICK_ATR_MULT * zone.atr) return null;
    if (useFakeoutFilter) {
      if (wickBeyond && reclaim && cl <= zone.upper) {
        return { direction: "long", entry: cl, stop: lo - tick, wick: lo, filtered: true };
      }
      return null;
    }
    if (lo <= zone.upper && cl <= zone.upper) {
      return { direction: "long", entry: cl, stop: Math.min(lo, zone.lower) - tick, wick: lo, filtered: false };
    }
    return null;
  }

  // supply
  const wickBeyond = hi > zone.upper;
  const reclaim = cl <= zone.upper;
  if (wickBeyond && hi - zone.upper > MAX_WICK_ATR_MULT * zone.atr) return null;
  if (useFakeoutFilter) {
    if (wickBeyond && reclaim && cl >= zone.lower) {
      return { direction: "short", entry: cl, stop: hi + tick, wick: hi, filtered: true };
    }
    return null;
  }
  if (hi >= zone.lower && cl >= zone.lower) {
    return { direction: "short", entry: cl, stop: Math.max(hi, zone.upper) + tick, wick: hi, filtered: false };
  }
  return null;
}

// ─── continuation / invalidation ────────────────────────────────────────────
/**
 * True if this candle's CLOSE punched decisively through VWAP in the trade's
 * direction (body-fraction gate AND ATR gate). Mirrors continuation_confirmed.
 */
export function continuationConfirmed(
  candle: Candle, vwap: number, direction: SniperDirection, atr5: number | null,
): boolean {
  const hi = candle[HIGH];
  const lo = candle[LOW];
  const cl = candle[CLOSE];
  const rng = Math.max(hi - lo, 1e-12);
  const beyond = direction === "long" ? cl - vwap : vwap - cl;
  if (beyond <= 0) return false;
  if (beyond < CONT_BODY_FRAC * rng) return false;
  if (atr5 != null && beyond < CONT_MIN_ATR_MULT * atr5) return false;
  return true;
}

/** Range level broke: a close beyond the zone. Mirrors zone_invalidated. */
export function zoneInvalidated(ltfCandle: Candle, zone: Zone): boolean {
  const cl = ltfCandle[CLOSE];
  return zone.kind === "demand" ? cl < zone.lower - 1e-12 : cl > zone.upper + 1e-12;
}
