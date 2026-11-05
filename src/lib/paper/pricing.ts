/**
 * Paper-engine pricing/geometry helpers — extracted from engine.ts (Phase 4C).
 *
 * SCOPE: pure functions only — slippage adjustment, percent distance, TP
 * structural validation, TP/stop pivot selection, protective-swing lookup,
 * and adverse Break-of-Structure detection. No I/O, no state, no strategy
 * decisions. Byte-identical to the previous inline engine definitions.
 *
 * `engine.ts` re-exports `mirrorTpFromStop`, `protectiveSwingForOpen`, and
 * `isAdverseBos` so external tests/callers keep the same public surface.
 */
import type { Direction, Swing } from "./signal";
import { meetsBosSignificance } from "./bosSignificance";
import {
  SLIP_RATE,
  MIN_STRUCTURAL_TP_DISTANCE_PCT,
  MIN_TP_TO_STOP_DISTANCE_RATIO,
} from "./constants";

/** Applies venue slippage to a raw price for the given side/direction. */
export function applySlip(px: number, side: Direction, isEntry: boolean): number {
  if (isEntry) return side === "long" ? px * (1 + SLIP_RATE) : px * (1 - SLIP_RATE);
  return side === "long" ? px * (1 - SLIP_RATE) : px * (1 + SLIP_RATE);
}

/** Inverse of applySlip for the entry side. */
export function removeEntrySlip(fillPx: number, side: Direction): number {
  return side === "long" ? fillPx / (1 + SLIP_RATE) : fillPx / (1 - SLIP_RATE);
}

export function pctDistance(a: number, b: number): number {
  return Math.abs(a - b) / b;
}

/** Minimum structural TP distance = max(floor pct, stop distance × R:R). */
export function minStructuralTpDistance(entryPx: number, stopLevel: number): number {
  const stopDistance = pctDistance(stopLevel, entryPx);
  return Math.max(MIN_STRUCTURAL_TP_DISTANCE_PCT, stopDistance * MIN_TP_TO_STOP_DISTANCE_RATIO);
}

export function isStructurallyValidTp(
  level: number, direction: Direction, entryPx: number,
  zoneUpper: number, zoneLower: number, stopLevel: number,
): boolean {
  if (direction === "long" && !(level > entryPx && level > zoneUpper)) return false;
  if (direction === "short" && !(level < entryPx && level < zoneLower)) return false;
  return pctDistance(level, entryPx) >= minStructuralTpDistance(entryPx, stopLevel);
}

/**
 * TP fallback when no confirmed favorable pivot exists yet. Projects the
 * structural minimum distance to the favorable side so the fallback honors
 * the SAME reward:risk ratio as the pivot path.
 */
export function mirrorTpFromStop(entryPx: number, stopLevel: number, direction: Direction): number {
  const dist = entryPx * minStructuralTpDistance(entryPx, stopLevel);
  return direction === "long" ? entryPx + dist : entryPx - dist;
}

/**
 * First CONFIRMED favorable swing pivot AFTER entry whose level sits
 * STRUCTURALLY OUTSIDE the entry setup's noise band.
 */
export function nextFavorablePivot(
  swings: Swing[], direction: Direction, entryIndex: number, entryPx: number,
  zoneUpper: number, zoneLower: number, stopLevel: number,
): { level: number; pivot_index: number; confirm_index: number } | null {
  const favKind = direction === "long" ? "high" : "low";
  const cands = swings
    .filter((s) => s.kind === favKind && s.pivot_index > entryIndex)
    .sort((a, b) => a.pivot_index - b.pivot_index);
  for (const s of cands) {
    if (isStructurallyValidTp(s.level, direction, entryPx, zoneUpper, zoneLower, stopLevel)) {
      return { level: s.level, pivot_index: s.pivot_index, confirm_index: s.confirm_index };
    }
  }
  return null;
}

/** Stop = most recent OPPOSITE pivot confirmed at/before entry. */
export function stopPivot(
  swings: Swing[], direction: Direction, entryIndex: number, entryPx: number,
): Swing | null {
  const kind = direction === "long" ? "low" : "high";
  const cands = swings.filter((s) => s.kind === kind && s.confirm_index <= entryIndex);
  if (!cands.length) return null;
  const stop = cands.reduce((a, b) => (a.pivot_index >= b.pivot_index ? a : b));
  if (direction === "long" && stop.level >= entryPx) return null;
  if (direction === "short" && stop.level <= entryPx) return null;
  return stop;
}

/**
 * SCOUT DEFENSIVE LAYER — protective swing for an OPEN position.
 * For a LONG position, most recent CONFIRMED higher-low swing BELOW the mark.
 * For a SHORT, most recent lower-high ABOVE the mark.
 */
export function protectiveSwingForOpen(
  swings: Swing[], direction: Direction, newestIndex: number, markPx: number,
): Swing | null {
  const kind = direction === "long" ? "low" : "high";
  const cands = swings.filter((s) => s.kind === kind && s.confirm_index <= newestIndex);
  if (!cands.length) return null;
  const filtered = cands.filter((s) =>
    direction === "long" ? s.level < markPx : s.level > markPx,
  );
  if (!filtered.length) return null;
  return filtered.reduce((a, b) => (a.pivot_index >= b.pivot_index ? a : b));
}

/**
 * True when the candle's CLOSE breaks the protective swing (adverse BOS)
 * AND that break clears the shared BOS significance floor
 * (`BOS_MIN_DISPLACEMENT_ATR × atr`). Sub-threshold pokes return false —
 * callers should treat them as noise and log via `bosBelowSignificanceDetail`.
 *
 * `atr` is the Wilder ATR on the SAME timeframe as `candleClose` at the
 * newest candle index (5m for the guardian, 1h for HTF paths). Passing
 * `null`/`undefined` (or a non-positive value) forces a `false` verdict —
 * an ambiguous ATR must never trigger an exit.
 */
export function isAdverseBos(
  direction: Direction, candleClose: number, swingLevel: number,
  atr: number | null | undefined,
): boolean {
  const bareBreak = direction === "long" ? candleClose < swingLevel : candleClose > swingLevel;
  if (!bareBreak) return false;
  // Adverse break direction is the OPPOSITE of the protective swing side:
  // for a LONG position, protective is a swing-low; an adverse break closes
  // BELOW it (direction=short for significance math). Mirror for shorts.
  const adverseDir: Direction = direction === "long" ? "short" : "long";
  return meetsBosSignificance(adverseDir, candleClose, swingLevel, atr);
}
