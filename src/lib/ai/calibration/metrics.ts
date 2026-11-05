// Pure calibration metrics for the SHADOW committee.
//
// AUTHORITY: NONE. These numbers describe how the advisory layer has behaved
// historically. Nothing reads them to gate, size, or place a trade.
//
// Two rules make the numbers honest:
//   1. COMPLETED TRADES ONLY. An open or cancelled candidate is never counted,
//      so a running winner cannot flatter the statistics.
//   2. MINIMUM SAMPLE. A bucket below MIN_SAMPLE reports `sufficient: false`
//      and no derived rate at all, rather than a rate built from three trades.

import { z } from "zod";
import { SCORE_BANDS, type ScoreBand } from "@/lib/ai/committee/score";
import { shadowVerdictSchema, type ShadowVerdict } from "@/lib/ai/committee/dto";

/** Bump when a metric definition changes. */
export const CALIBRATION_VERSION = "calibration.v1";

/** Below this, a bucket reports no rates. Small samples are noise. */
export const MIN_SAMPLE = 10;

export const calibrationSampleSchema = z.object({
  verdict: shadowVerdictSchema,
  scoreBand: z.enum(SCORE_BANDS).nullable(),
  /** 0..100 shadow score, used as the predicted win probability / 100. */
  shadowScore: z.number().nullable(),
  promptVersion: z.string().nullable(),
  scorerVersion: z.string().nullable(),
  /** Only "closed" is ever counted. */
  status: z.enum(["open", "closed", "cancelled"]),
  outcome: z.enum(["win", "loss", "scratch"]).nullable(),
  rMultiple: z.number().nullable(),
  realizedPnlUsd: z.number().nullable(),
});
export type CalibrationSample = z.infer<typeof calibrationSampleSchema>;

export interface BucketMetrics {
  key: string;
  /** Completed trades in this bucket. */
  sample: number;
  /** Wins + losses (scratches excluded from rate math). */
  decisive: number;
  sufficient: boolean;
  /** null until `sufficient`. Never a placeholder zero. */
  winRate: number | null;
  meanR: number | null;
  totalPnlUsd: number | null;
  /** Mean squared error of shadowScore/100 vs realised win. Lower is better. */
  brier: number | null;
}

export interface CalibrationReport {
  version: string;
  minSample: number;
  /** Completed trades considered across all buckets. */
  totalCompleted: number;
  overall: BucketMetrics;
  byVerdict: BucketMetrics[];
  byBand: BucketMetrics[];
}

function isCompleted(s: CalibrationSample): boolean {
  return s.status === "closed" && s.outcome !== null;
}

function bucket(key: string, samples: CalibrationSample[]): BucketMetrics {
  const completed = samples.filter(isCompleted);
  const decisiveSamples = completed.filter((s) => s.outcome === "win" || s.outcome === "loss");
  const sufficient = completed.length >= MIN_SAMPLE;

  if (!sufficient) {
    return {
      key,
      sample: completed.length,
      decisive: decisiveSamples.length,
      sufficient: false,
      winRate: null,
      meanR: null,
      totalPnlUsd: null,
      brier: null,
    };
  }

  const wins = decisiveSamples.filter((s) => s.outcome === "win").length;
  const rs = completed.map((s) => s.rMultiple).filter((r): r is number => r != null && Number.isFinite(r));
  const pnls = completed
    .map((s) => s.realizedPnlUsd)
    .filter((p): p is number => p != null && Number.isFinite(p));
  const scored = decisiveSamples.filter(
    (s) => s.shadowScore != null && Number.isFinite(s.shadowScore),
  );

  return {
    key,
    sample: completed.length,
    decisive: decisiveSamples.length,
    sufficient: true,
    winRate: decisiveSamples.length ? wins / decisiveSamples.length : null,
    meanR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    totalPnlUsd: pnls.length ? pnls.reduce((a, b) => a + b, 0) : null,
    brier: scored.length
      ? scored.reduce((a, s) => {
          const p = Math.min(1, Math.max(0, (s.shadowScore as number) / 100));
          const actual = s.outcome === "win" ? 1 : 0;
          return a + (p - actual) ** 2;
        }, 0) / scored.length
      : null,
  };
}

export function buildCalibrationReport(samples: CalibrationSample[]): CalibrationReport {
  const completed = samples.filter(isCompleted);
  const verdicts: ShadowVerdict[] = [
    "shadow_endorse",
    "shadow_weak_endorse",
    "shadow_reject",
    "shadow_no_consensus",
    "shadow_unavailable",
  ];
  const bands: ScoreBand[] = [...SCORE_BANDS];

  return {
    version: CALIBRATION_VERSION,
    minSample: MIN_SAMPLE,
    totalCompleted: completed.length,
    overall: bucket("overall", samples),
    byVerdict: verdicts.map((v) => bucket(v, samples.filter((s) => s.verdict === v))),
    byBand: bands.map((b) => bucket(b, samples.filter((s) => s.scoreBand === b))),
  };
}
