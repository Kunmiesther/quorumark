/**
 * Service-level objectives for the paper control plane.
 *
 * Values are ENGINEERING TARGETS measured by telemetry. They are NOT
 * guarantees of successful or profitable trades — only that the system
 * is doing its assigned job on the promised cadence.
 *
 * All values in milliseconds unless noted.
 */

export const SLO = {
  /** Scheduler lateness (actual tick - expected tick). */
  scheduler_lateness_ms: { p50: 3_000, p95: 15_000 },
  /** Freshness of closed candles by timeframe. */
  data_freshness_ms: {
    "5m":  { p50:  60_000, p95:  90_000 },
    "15m": { p50: 120_000, p95: 240_000 },
    "1h":  { p50: 300_000, p95: 600_000 },
    "4h":  { p50: 900_000, p95: 1_800_000 },
    "1d":  { p50: 1_800_000, p95: 3_600_000 },
    "1w":  { p50: 3_600_000, p95: 7_200_000 },
    "1M":  { p50: 3_600_000, p95: 7_200_000 },
  },
  /** Scout scan computation. */
  scout_scan_duration_ms: { p50: 2_000, p95: 8_000 },
  /** Scout→Onyx handoff. */
  scout_to_onyx_ms: { p50: 500, p95: 2_000 },
  /** Onyx decision. */
  onyx_decision_ms: { p50: 1_500, p95: 5_000 },
  /** Intent claim + submission (paper). */
  intent_processing_ms: { p50: 500, p95: 2_000 },
} as const;

export type SloTarget = { p50: number; p95: number };

export interface SloObservation {
  name: string;
  observed_p50_ms: number | null;
  observed_p95_ms: number | null;
  target: SloTarget;
  violations: number;
}

/**
 * Compare observed samples to an SLO target. Pure — supply nowMs upstream.
 * `violations` counts samples > target.p95.
 */
export function evaluateSlo(name: string, samples_ms: number[], target: SloTarget): SloObservation {
  if (samples_ms.length === 0) {
    return { name, observed_p50_ms: null, observed_p95_ms: null, target, violations: 0 };
  }
  const sorted = [...samples_ms].sort((a, b) => a - b);
  const pick = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  const violations = samples_ms.reduce((n, v) => (v > target.p95 ? n + 1 : n), 0);
  return {
    name,
    observed_p50_ms: pick(50),
    observed_p95_ms: pick(95),
    target,
    violations,
  };
}
