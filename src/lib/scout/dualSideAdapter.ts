/**
 * ADAPTER — turn per-symbol MTF `CompactEvidence` into `TimeframeEvidence`
 * rows the `dualDirection` evaluator can consume, then produce a persistence
 * payload for the new per-side columns on `scout_signals`.
 *
 * Pure. No I/O. No writes. Freshness/insufficient-evidence semantics come
 * straight from `CompactEvidence.data_quality` and the `direction === 'none'`
 * flag — this adapter never fabricates evidence.
 */
import type { CompactEvidence } from "./evidence";
import type { Timeframe as ScoutTimeframe } from "./types";
import {
  evaluateDualDirection,
  type DualEvaluation,
  type SideEvaluation,
  type TimeframeEvidence,
  type Timeframe as DualTimeframe,
} from "./dualDirection";

/** Only these four timeframes participate in dual-direction scoring today. */
const DUAL_TFS: readonly DualTimeframe[] = ["H4", "H1", "M15", "M5"] as const;

/**
 * Convert a scout `CompactEvidence` snapshot to a `TimeframeEvidence` row.
 * Missing/insufficient evidence surfaces as `missingContext=true`; stale
 * data keeps `fresh=false` but still contributes if numeric.
 */
export function toTimeframeEvidence(ev: CompactEvidence): TimeframeEvidence {
  const tf = ev.timeframe as unknown as DualTimeframe;
  const hasNumericScore = Number.isFinite(ev.score);
  // `direction: 'none'` combined with the evidence builder's own
  // "empty()" path signals insufficient inputs — never mark that side.
  const noSignalAtAll =
    !hasNumericScore ||
    (ev.direction === "none" &&
      (ev.reason_codes.includes("insufficient_history") ||
        ev.reason_codes.includes("missing_fields") ||
        (!ev.data_quality.fresh && ev.score === 0)));

  return {
    tf,
    score: noSignalAtAll ? null : ev.score,
    fresh: !!ev.data_quality.fresh,
    missingContext: noSignalAtAll,
    reasons: ev.reason_codes,
  };
}

export interface DualSidePayload {
  long_score: number;
  short_score: number;
  long_state: SideEvaluation["state"];
  short_state: SideEvaluation["state"];
  long_aligned_tfs: string[];
  short_aligned_tfs: string[];
  long_reason_codes: string[];
  short_reason_codes: string[];
  long_fresh: boolean;
  short_fresh: boolean;
  long_insufficient: boolean;
  short_insufficient: boolean;
  dominant_side: DualEvaluation["dominant"];
}

/**
 * Build the DB payload of new `scout_signals` columns from an evidence map.
 * Called with the same per-symbol `evidenceByTf` the pipeline already
 * builds — no extra fetches.
 */
export function buildDualSidePayload(
  evidenceByTf: Map<ScoutTimeframe, CompactEvidence>,
): DualSidePayload {
  const rows: TimeframeEvidence[] = [];
  for (const tf of DUAL_TFS) {
    const ev = evidenceByTf.get(tf as ScoutTimeframe);
    if (!ev) {
      rows.push({ tf, score: null, fresh: false, missingContext: true, reasons: [] });
      continue;
    }
    rows.push(toTimeframeEvidence(ev));
  }
  const evalOut = evaluateDualDirection(rows);
  return {
    long_score: evalOut.long.weightedScore,
    short_score: evalOut.short.weightedScore,
    long_state: evalOut.long.state,
    short_state: evalOut.short.state,
    long_aligned_tfs: evalOut.long.alignedTfs,
    short_aligned_tfs: evalOut.short.alignedTfs,
    long_reason_codes: evalOut.long.reasonCodes,
    short_reason_codes: evalOut.short.reasonCodes,
    long_fresh: !evalOut.long.hasFreshnessGap && !evalOut.long.insufficientEvidence,
    short_fresh: !evalOut.short.hasFreshnessGap && !evalOut.short.insufficientEvidence,
    long_insufficient: evalOut.long.insufficientEvidence,
    short_insufficient: evalOut.short.insufficientEvidence,
    dominant_side: evalOut.dominant,
  };
}
