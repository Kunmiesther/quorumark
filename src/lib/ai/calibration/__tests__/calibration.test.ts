// Calibration metric tests.
//
// The two properties that matter: only completed trades count, and a bucket
// under MIN_SAMPLE reports nothing rather than a misleading rate.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MIN_SAMPLE,
  buildCalibrationReport,
  type CalibrationSample,
} from "@/lib/ai/calibration/metrics";

function sample(over: Partial<CalibrationSample> = {}): CalibrationSample {
  return {
    verdict: "shadow_endorse",
    scoreBand: "strong",
    shadowScore: 80,
    promptVersion: "prompt.v1",
    scorerVersion: "scorer.v1",
    status: "closed",
    outcome: "win",
    rMultiple: 1.5,
    realizedPnlUsd: 12,
    ...over,
  };
}

describe("calibration metrics", () => {
  it("ignores open and cancelled candidates entirely", () => {
    const samples = [
      ...Array.from({ length: MIN_SAMPLE }, () => sample()),
      ...Array.from({ length: 50 }, () => sample({ status: "open", outcome: null })),
      ...Array.from({ length: 50 }, () => sample({ status: "cancelled", outcome: null })),
    ];
    const r = buildCalibrationReport(samples);
    expect(r.totalCompleted).toBe(MIN_SAMPLE);
    expect(r.overall.sample).toBe(MIN_SAMPLE);
  });

  it("reports no rates below the minimum sample", () => {
    const r = buildCalibrationReport(Array.from({ length: MIN_SAMPLE - 1 }, () => sample()));
    expect(r.overall.sufficient).toBe(false);
    expect(r.overall.winRate).toBeNull();
    expect(r.overall.meanR).toBeNull();
    expect(r.overall.brier).toBeNull();
  });

  it("computes win rate from decisive trades only", () => {
    const samples = [
      ...Array.from({ length: 6 }, () => sample({ outcome: "win" })),
      ...Array.from({ length: 2 }, () => sample({ outcome: "loss" })),
      ...Array.from({ length: 4 }, () => sample({ outcome: "scratch" })),
    ];
    const r = buildCalibrationReport(samples);
    expect(r.overall.sample).toBe(12);
    expect(r.overall.decisive).toBe(8);
    expect(r.overall.winRate).toBeCloseTo(0.75, 5);
  });

  it("scores a perfectly calibrated set better than an overconfident one", () => {
    const confidentCorrect = buildCalibrationReport(
      Array.from({ length: MIN_SAMPLE }, () => sample({ shadowScore: 100, outcome: "win" })),
    );
    const confidentWrong = buildCalibrationReport(
      Array.from({ length: MIN_SAMPLE }, () => sample({ shadowScore: 100, outcome: "loss" })),
    );
    expect(confidentCorrect.overall.brier).toBeCloseTo(0, 5);
    expect(confidentWrong.overall.brier).toBeCloseTo(1, 5);
  });

  it("buckets independently by verdict and by band", () => {
    const samples = [
      ...Array.from({ length: MIN_SAMPLE }, () => sample()),
      ...Array.from({ length: MIN_SAMPLE }, () =>
        sample({ verdict: "shadow_reject", scoreBand: "avoid", outcome: "loss" }),
      ),
    ];
    const r = buildCalibrationReport(samples);
    const endorse = r.byVerdict.find((b) => b.key === "shadow_endorse")!;
    const reject = r.byVerdict.find((b) => b.key === "shadow_reject")!;
    expect(endorse.winRate).toBe(1);
    expect(reject.winRate).toBe(0);
    expect(r.byBand.find((b) => b.key === "strong")!.sample).toBe(MIN_SAMPLE);
  });

  it("keeps the calibration layer read-only and execution-free", () => {
    const files = [
      "src/lib/ai/calibration/metrics.ts",
      "src/lib/ai/calibration.functions.ts",
      "src/components/trade/CommitteeCalibrationPanel.tsx",
    ];
    for (const f of files) {
      // Strip comments: prose describing the isolation must not satisfy it.
      const src = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(src).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
      expect(src).not.toMatch(/signer|submit_order|submitOrder|supabaseAdmin|ledgerClient/i);
    }
  });
});
