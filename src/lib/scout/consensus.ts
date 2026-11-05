/**
 * Multi-timeframe consensus aggregator.
 *
 * - Weighted sum by TIMEFRAME_WEIGHT.
 * - Higher timeframes (M+W+D+H4 = 0.55) dominate: 5m alone can never flip
 *   the macro bias.
 * - Dead-zone ±0.20 around 0 → "balanced".
 * - Missing/stale `H4` or `D` degrades to "no-signal".
 * - Conflict = normalized variance across per-TF scores.
 * - Confidence = |weighted| × availability × (1 − conflict/2).
 *
 * Pure. No I/O.
 */
import type { Bias, ConsensusResult, Readiness, TimeframeState } from "./types";
import { TIMEFRAME_WEIGHT, TIMEFRAMES } from "./types";

export const BIAS_DEAD_ZONE = 0.20;

export function computeConsensus(states: TimeframeState[]): ConsensusResult {
  const byTf = new Map(states.map((s) => [s.tf, s]));
  let weightedSum = 0;
  let weightUsed = 0;
  const scores: number[] = [];

  for (const tf of TIMEFRAMES) {
    const st = byTf.get(tf);
    const w = TIMEFRAME_WEIGHT[tf];
    if (!st || st.state === "unavailable") continue;
    weightedSum += st.score * w;
    weightUsed += w;
    scores.push(st.score);
  }

  const totalWeight = TIMEFRAMES.reduce((acc, tf) => acc + TIMEFRAME_WEIGHT[tf], 0);
  const availability = totalWeight > 0 ? weightUsed / totalWeight : 0;

  // Conflict: normalized stddev across present scores (0..1).
  let conflict = 0;
  if (scores.length >= 2) {
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
    conflict = Math.min(1, Math.sqrt(variance));
  }

  const h4 = byTf.get("H4");
  const d = byTf.get("D");
  const higherOk =
    !!h4 && h4.state !== "unavailable" && !h4.stale &&
    !!d && d.state !== "unavailable" && !d.stale;

  let bias: Bias;
  if (!higherOk) {
    bias = "no-signal";
  } else if (weightedSum > BIAS_DEAD_ZONE) {
    bias = "long-priority";
  } else if (weightedSum < -BIAS_DEAD_ZONE) {
    bias = "short-priority";
  } else {
    bias = "balanced";
  }

  // Readiness: armed when H1 + M15 agree with bias AND M5 confirms.
  let readiness: Readiness = "no-signal";
  if (bias === "long-priority" || bias === "short-priority") {
    const dir = bias === "long-priority" ? +1 : -1;
    const h1 = byTf.get("H1");
    const m15 = byTf.get("M15");
    const m5 = byTf.get("M5");
    const agrees = (s?: TimeframeState) =>
      !!s && !s.stale && s.state !== "unavailable" && Math.sign(s.score) === dir;
    if (agrees(h1) && agrees(m15) && agrees(m5)) readiness = "armed";
    else readiness = "watching";
  }

  const confidence = Math.max(
    0,
    Math.min(1, Math.abs(weightedSum) * availability * (1 - conflict / 2)),
  );

  return {
    bias,
    readiness,
    weightedScore: weightedSum,
    confidence,
    conflict,
    availability,
  };
}
