// Deterministic take-profit proximity math for the trade chart.
//
// PURE. No React, no network, no clock reads except the caller-supplied
// `nowMs`. Every branch is total: missing / non-finite / contradictory
// inputs resolve to a safe "idle" tracker rather than throwing.
//
// Proximity rule (identical shape for long and short):
//
//   travelled = |price - entry|   measured ALONG the profit direction
//   span      = |tp    - entry|
//   progress  = clamp(travelled / span, 0, 1)
//   remaining = 1 - progress
//
//   remaining <= 0            -> "hit"       stable gold, no animation
//   remaining <= 0.05         -> "imminent"  gold + pulse
//   remaining <= 0.15         -> "approach"  gold fade-in, no pulse
//   otherwise                 -> "idle"      normal theme marker
//
// `goldMix` is a 0..1 ramp used by the renderer to interpolate the marker
// from the theme colour to gold. It rises linearly across the approach
// band so the transition never snaps or flashes.

export type TpPhase = "idle" | "approach" | "imminent" | "hit";
export type TradeSide = "long" | "short";

/** Threshold constants — exported so tests and the UI agree exactly. */
export const TP_APPROACH_REMAINING = 0.15;
export const TP_IMMINENT_REMAINING = 0.05;
/** A price older than this is treated as unusable (no proximity claim). */
export const TP_STALE_PRICE_MS = 30_000;

export interface TpLevel {
  /** 1-based label index as displayed on the chart (TP1, TP2, …). */
  index: number;
  price: number;
  /** True when the venue/backend reports this tier as already filled. */
  hit: boolean;
}

export interface TpProximityInput {
  side: TradeSide | null | undefined;
  /** Average/planned entry. Required — without it there is no span. */
  entry: number | null | undefined;
  /** Current live price. */
  price: number | null | undefined;
  /** Timestamp of `price`. Omit to skip the staleness check. */
  priceAt?: number | null;
  nowMs?: number;
  /** Raw TP prices in backend order, or pre-labelled levels. */
  tps: Array<number | null | undefined> | TpLevel[] | null | undefined;
  /** Indices (1-based) the backend reports as already filled. */
  hitIndices?: number[] | null;
  staleMs?: number;
}

export interface TpProximityResult {
  phase: TpPhase;
  /** 0..1 ramp toward gold. 0 = theme colour, 1 = full gold. */
  goldMix: number;
  /** Should the marker pulse? Callers must still AND this with !reducedMotion. */
  pulse: boolean;
  /** The next unhit TP, or null when there is none to track. */
  nextTp: TpLevel | null;
  /** Fraction of the entry->TP span already travelled (0..1). */
  progress: number;
  /** Absolute price distance to the next TP (>= 0), null when unknown. */
  priceDistance: number | null;
  /** Signed-magnitude move required, as a % of current price. */
  pctDistance: number | null;
  /** All levels, normalised and labelled, in backend order. */
  levels: TpLevel[];
  /** Why the tracker is inactive, for UI copy. null when active. */
  reason:
    | null
    | "no_position"
    | "no_tp_data"
    | "all_tps_hit"
    | "stale_price"
    | "invalid_geometry";
}

const IDLE: TpProximityResult = {
  phase: "idle",
  goldMix: 0,
  pulse: false,
  nextTp: null,
  progress: 0,
  priceDistance: null,
  pctDistance: null,
  levels: [],
  reason: "no_position",
};

function idle(reason: TpProximityResult["reason"], levels: TpLevel[] = []): TpProximityResult {
  return { ...IDLE, levels, reason };
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Normalise a mixed TP input into labelled, finite, ordered levels. */
export function normalizeTpLevels(
  tps: TpProximityInput["tps"],
  hitIndices?: number[] | null,
): TpLevel[] {
  if (!Array.isArray(tps)) return [];
  const hitSet = new Set((hitIndices ?? []).filter((n) => Number.isInteger(n)));
  const out: TpLevel[] = [];
  tps.forEach((raw, i) => {
    if (raw != null && typeof raw === "object") {
      const lvl = raw as TpLevel;
      if (!isNum(lvl.price)) return;
      const index = Number.isInteger(lvl.index) ? lvl.index : i + 1;
      out.push({ index, price: lvl.price, hit: Boolean(lvl.hit) || hitSet.has(index) });
      return;
    }
    if (!isNum(raw)) return;
    const index = i + 1;
    out.push({ index, price: raw, hit: hitSet.has(index) });
  });
  return out;
}

/**
 * Compute the marker phase + distance readout for the next unhit TP.
 * Never throws. Always returns a renderable result.
 */
export function computeTpProximity(input: TpProximityInput): TpProximityResult {
  const side = input.side === "long" || input.side === "short" ? input.side : null;
  const levels = normalizeTpLevels(input.tps, input.hitIndices);

  if (!side || !isNum(input.entry)) return idle("no_position", levels);
  if (!isNum(input.price)) return idle("stale_price", levels);
  if (!levels.length) return idle("no_tp_data", levels);

  // Staleness: an old tick must not drive a gold "about to hit" signal.
  const staleMs = input.staleMs ?? TP_STALE_PRICE_MS;
  if (isNum(input.priceAt)) {
    const now = isNum(input.nowMs) ? input.nowMs : Date.now();
    if (now - input.priceAt > staleMs) return idle("stale_price", levels);
  }

  const entry = input.entry;
  const price = input.price;
  const dir = side === "long" ? 1 : -1;

  // Treat a TP that price has already run through as hit, even if the
  // backend has not yet recorded the fill — but keep backend `hit` as the
  // authority for the label. Ordering follows profit direction.
  const pending = levels
    .filter((l) => !l.hit)
    .filter((l) => dir * (l.price - entry) > 0) // must be on the profit side
    .sort((a, b) => dir * (a.price - b.price));

  if (!pending.length) {
    const allHit = levels.every((l) => l.hit);
    return idle(allHit ? "all_tps_hit" : "invalid_geometry", levels);
  }

  const nextTp = pending[0];
  const span = Math.abs(nextTp.price - entry);
  if (!(span > 0)) return idle("invalid_geometry", levels);

  const travelled = dir * (price - entry); // negative when price is offside
  const progress = clamp01(travelled / span);
  // Epsilon absorbs float error so an exact 15%/5% boundary lands inside the
  // band rather than one ULP outside it.
  const EPS = 1e-9;
  const remaining = 1 - progress;

  const priceDistance = Math.max(0, dir * (nextTp.price - price));
  const pctDistance = price !== 0 ? (priceDistance / Math.abs(price)) * 100 : null;

  let phase: TpPhase;
  let goldMix: number;
  let pulse = false;

  if (remaining <= EPS) {
    phase = "hit";
    goldMix = 1;
  } else if (remaining <= TP_IMMINENT_REMAINING + EPS) {
    phase = "imminent";
    goldMix = 1;
    pulse = true;
  } else if (remaining <= TP_APPROACH_REMAINING + EPS) {
    phase = "approach";
    // Linear ramp across the approach band: 0 at 15% remaining, 1 at 5%.
    const t =
      (TP_APPROACH_REMAINING - remaining) /
      (TP_APPROACH_REMAINING - TP_IMMINENT_REMAINING);
    goldMix = clamp01(t);
  } else {
    phase = "idle";
    goldMix = 0;
  }

  return {
    phase,
    goldMix,
    pulse,
    nextTp,
    progress,
    priceDistance,
    pctDistance,
    levels,
    reason: null,
  };
}

/** Compact human label, e.g. "TP2 · 0.42% · 268.4". Safe on any result. */
export function formatTpDistance(
  r: TpProximityResult,
  fmtPrice: (n: number) => string,
): string | null {
  if (!r.nextTp || r.pctDistance == null || r.priceDistance == null) return null;
  if (r.phase === "hit") return `TP${r.nextTp.index} REACHED`;
  return `TP${r.nextTp.index} · ${r.pctDistance.toFixed(2)}% · ${fmtPrice(r.priceDistance)}`;
}
