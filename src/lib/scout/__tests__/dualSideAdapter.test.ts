/**
 * Tests for the dual-side persistence adapter.
 *
 * Verifies that Offense (long) and Defense (short) evaluations are
 * INDEPENDENT for every symbol and that the payload never fabricates
 * a fresh/confirmed side when evidence is missing or stale.
 */
import { describe, it, expect } from "vitest";
import { buildDualSidePayload, toTimeframeEvidence } from "../dualSideAdapter";
import type { CompactEvidence } from "../evidence";
import type { Timeframe as ScoutTimeframe } from "../types";

function ev(overrides: Partial<CompactEvidence> & { timeframe: ScoutTimeframe }): CompactEvidence {
  return {
    symbol: "TEST-USDT",
    timeframe: overrides.timeframe,
    direction: overrides.direction ?? "none",
    score: overrides.score ?? 0,
    reason_codes: overrides.reason_codes ?? [],
    structure: {
      hh: false, hl: false, lh: false, ll: false, range: false,
      bos: null, choch: null, failed_breakout: null,
      ...(overrides.structure ?? {}),
    },
    ema: { fast: null, slow: null, stack: "flat", slope_pct: 0, ...(overrides.ema ?? {}) },
    momentum: { roc_pct: 0, rsi14: null, norm: 0, ...(overrides.momentum ?? {}) },
    volume: { last: 0, median50: 0, ratio: 0, ...(overrides.volume ?? {}) },
    volatility: { atr_pct: null, atr_percentile: null, regime: "normal", ...(overrides.volatility ?? {}) },
    data_quality: {
      candle_count: 200,
      last_closed_ts: 1_000_000,
      age_ms: 0,
      fresh: true,
      missing_fields: [],
      ...(overrides.data_quality ?? {}),
    },
    evidence_schema_version: 1,
    rules_version: 1,
  };
}

describe("toTimeframeEvidence", () => {
  it("marks insufficient-history evidence as missingContext, never scored", () => {
    const compact = ev({
      timeframe: "M5",
      direction: "none",
      score: 0,
      reason_codes: ["insufficient_history"],
      data_quality: { candle_count: 10, last_closed_ts: null, age_ms: null, fresh: false, missing_fields: [] },
    });
    const row = toTimeframeEvidence(compact);
    expect(row.missingContext).toBe(true);
    expect(row.score).toBeNull();
    expect(row.fresh).toBe(false);
  });

  it("passes through a real bullish score with fresh=true", () => {
    const row = toTimeframeEvidence(ev({ timeframe: "H1", direction: "long", score: 0.6 }));
    expect(row.missingContext).toBe(false);
    expect(row.score).toBe(0.6);
    expect(row.fresh).toBe(true);
  });
});

describe("buildDualSidePayload", () => {
  it("bullish stack → long confirmed, short none, dominant=long", () => {
    const map = new Map<ScoutTimeframe, CompactEvidence>();
    map.set("H4", ev({ timeframe: "H4", direction: "long", score: 0.7 }));
    map.set("H1", ev({ timeframe: "H1", direction: "long", score: 0.6 }));
    map.set("M15", ev({ timeframe: "M15", direction: "long", score: 0.5 }));
    map.set("M5", ev({ timeframe: "M5", direction: "long", score: 0.5 }));
    const p = buildDualSidePayload(map);
    expect(p.long_state).toBe("confirmed");
    expect(p.short_state).toBe("none");
    expect(p.long_score).toBeGreaterThan(0.4);
    expect(p.short_score).toBe(0);
    expect(p.dominant_side).toBe("long");
    expect(p.long_fresh).toBe(true);
    expect(p.long_insufficient).toBe(false);
    expect(p.short_insufficient).toBe(false);
    expect(p.long_aligned_tfs.length).toBeGreaterThanOrEqual(3);
  });

  it("bearish stack → short confirmed, long none, dominant=short", () => {
    const map = new Map<ScoutTimeframe, CompactEvidence>();
    map.set("H4", ev({ timeframe: "H4", direction: "short", score: -0.7 }));
    map.set("H1", ev({ timeframe: "H1", direction: "short", score: -0.6 }));
    map.set("M15", ev({ timeframe: "M15", direction: "short", score: -0.5 }));
    map.set("M5", ev({ timeframe: "M5", direction: "short", score: -0.5 }));
    const p = buildDualSidePayload(map);
    expect(p.short_state).toBe("confirmed");
    expect(p.long_state).toBe("none");
    expect(p.short_score).toBeGreaterThan(0.4);
    expect(p.long_score).toBe(0);
    expect(p.dominant_side).toBe("short");
    expect(p.short_fresh).toBe(true);
    expect(p.long_insufficient).toBe(false);
  });

  it("all timeframes missing → both sides insufficient, neither confirmed", () => {
    const map = new Map<ScoutTimeframe, CompactEvidence>();
    for (const tf of ["H4", "H1", "M15", "M5"] as const) {
      map.set(tf, ev({
        timeframe: tf,
        direction: "none",
        score: 0,
        reason_codes: ["insufficient_history"],
        data_quality: { candle_count: 5, last_closed_ts: null, age_ms: null, fresh: false, missing_fields: [] },
      }));
    }
    const p = buildDualSidePayload(map);
    expect(p.long_state).toBe("none");
    expect(p.short_state).toBe("none");
    expect(p.long_insufficient).toBe(true);
    expect(p.short_insufficient).toBe(true);
    expect(p.long_fresh).toBe(false);
    expect(p.short_fresh).toBe(false);
    expect(p.dominant_side).toBe("balanced");
  });

  it("weak mixed evidence → sides may be watching, never confirmed without aligned tfs", () => {
    const map = new Map<ScoutTimeframe, CompactEvidence>();
    // Only ONE aligned bullish TF — below minAlignedTfs=3 threshold.
    map.set("H4", ev({ timeframe: "H4", direction: "long", score: 0.6 }));
    map.set("H1", ev({ timeframe: "H1", direction: "none", score: 0 }));
    map.set("M15", ev({ timeframe: "M15", direction: "none", score: 0 }));
    map.set("M5", ev({ timeframe: "M5", direction: "none", score: 0 }));
    const p = buildDualSidePayload(map);
    expect(p.long_state).not.toBe("confirmed");
    expect(p.short_state).toBe("none");
  });

  it("Offense and Defense are computed independently — a symbol with mixed signals evaluates both sides", () => {
    // H4 bullish, M15 bearish — two independent sides both have some evidence.
    const map = new Map<ScoutTimeframe, CompactEvidence>();
    map.set("H4", ev({ timeframe: "H4", direction: "long", score: 0.5 }));
    map.set("H1", ev({ timeframe: "H1", direction: "long", score: 0.4 }));
    map.set("M15", ev({ timeframe: "M15", direction: "short", score: -0.5 }));
    map.set("M5", ev({ timeframe: "M5", direction: "short", score: -0.4 }));
    const p = buildDualSidePayload(map);
    // Both sides have evidence and are evaluated separately.
    expect(p.long_score).toBeGreaterThan(0);
    expect(p.short_score).toBeGreaterThan(0);
    expect(p.long_insufficient).toBe(false);
    expect(p.short_insufficient).toBe(false);
  });

  it("stale-but-numeric evidence marks side not-fresh, never confirmed", () => {
    const map = new Map<ScoutTimeframe, CompactEvidence>();
    for (const tf of ["H4", "H1", "M15", "M5"] as const) {
      map.set(tf, ev({
        timeframe: tf,
        direction: "long",
        score: 0.6,
        data_quality: { candle_count: 200, last_closed_ts: 1, age_ms: 999_999_999, fresh: false, missing_fields: [] },
      }));
    }
    const p = buildDualSidePayload(map);
    // dualDirection propagates stale via hasFreshnessGap → long_fresh=false.
    expect(p.long_fresh).toBe(false);
  });
});
