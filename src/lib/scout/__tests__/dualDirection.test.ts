/**
 * Dual-direction Scout invariant regressions.
 *
 * Scout must always evaluate both sides independently. Open positions may
 * ONLY be attached as display context and must never mutate raw scores.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateDualDirection,
  annotateWithPositionContext,
  type TimeframeEvidence,
} from "../dualDirection";
import { buildBothOpportunities } from "../opportunity";

const BULLISH_STACK: TimeframeEvidence[] = [
  { tf: "H4", score: 0.77, fresh: true, reasons: ["ema_stack_up"] },
  { tf: "H1", score: 0.64, fresh: true, reasons: ["ema_stack_up"] },
  { tf: "M15", score: 0.52, fresh: true, reasons: ["ema_stack_up"] },
  { tf: "M5", score: 0.51, fresh: true, reasons: ["ema_stack_up"] },
];

const BEARISH_STACK: TimeframeEvidence[] = BULLISH_STACK.map((e) => ({
  ...e,
  score: e.score == null ? null : -e.score,
  reasons: ["ema_stack_down"],
}));

describe("evaluateDualDirection", () => {
  // Test 1: open long ladder must not suppress a valid short signal.
  it("open long ladder + downtrend → SHORT confirmed, LONG none; identical raw scores", () => {
    const raw = evaluateDualDirection(BEARISH_STACK);
    const withPos = annotateWithPositionContext(raw, {
      hasOpenLongLadder: true,
      hasOpenShortLadder: false,
    });

    expect(raw.short.state).toBe("confirmed");
    expect(raw.long.state).toBe("none");
    expect(raw.dominant).toBe("short");

    // Position context MUST NOT change scores or state.
    expect(withPos.short.state).toBe(raw.short.state);
    expect(withPos.short.weightedScore).toBe(raw.short.weightedScore);
    expect(withPos.short.reasonCodes).toEqual(raw.short.reasonCodes);
    expect(withPos.long.weightedScore).toBe(raw.long.weightedScore);
    expect(withPos.context.hasOpenLongLadder).toBe(true);
  });

  // Test 2: open short ladder must not suppress a valid long signal (mirror).
  it("open short ladder + uptrend → LONG confirmed, SHORT none; identical raw scores", () => {
    const raw = evaluateDualDirection(BULLISH_STACK);
    const withPos = annotateWithPositionContext(raw, {
      hasOpenLongLadder: false,
      hasOpenShortLadder: true,
    });
    expect(raw.long.state).toBe("confirmed");
    expect(raw.short.state).toBe("none");
    expect(raw.dominant).toBe("long");
    expect(withPos.long.weightedScore).toBe(raw.long.weightedScore);
    expect(withPos.long.reasonCodes).toEqual(raw.long.reasonCodes);
  });

  // Test 3: raw scores are byte-identical with vs without an open position.
  it("byte-identical raw scores regardless of open-position context", () => {
    const raw = evaluateDualDirection(BEARISH_STACK);
    const withNothing = annotateWithPositionContext(raw, {
      hasOpenLongLadder: false,
      hasOpenShortLadder: false,
    });
    const withLong = annotateWithPositionContext(raw, {
      hasOpenLongLadder: true,
      hasOpenShortLadder: false,
    });
    const withShort = annotateWithPositionContext(raw, {
      hasOpenLongLadder: false,
      hasOpenShortLadder: true,
    });
    // Every score and reason list must match across annotations.
    for (const a of [withNothing, withLong, withShort]) {
      expect(a.long.weightedScore).toBe(raw.long.weightedScore);
      expect(a.short.weightedScore).toBe(raw.short.weightedScore);
      expect(a.long.reasonCodes).toEqual(raw.long.reasonCodes);
      expect(a.short.reasonCodes).toEqual(raw.short.reasonCodes);
      expect(a.long.state).toBe(raw.long.state);
      expect(a.short.state).toBe(raw.short.state);
      expect(a.dominant).toBe(raw.dominant);
    }
  });

  // Missing-context and stale timeframes never count as bullish or bearish.
  it("missing-context timeframes emit insufficient_evidence and do not vote", () => {
    const evidence: TimeframeEvidence[] = [
      { tf: "H4", score: null, fresh: false, missingContext: true },
      { tf: "H1", score: 0.6, fresh: true, reasons: ["ema_stack_up"] },
      { tf: "M15", score: 0.4, fresh: true, reasons: ["ema_stack_up"] },
      { tf: "M5", score: 0.3, fresh: false, reasons: ["stale_data", "ema_stack_up"] },
    ];
    const raw = evaluateDualDirection(evidence);
    expect(raw.long.reasonCodes).toContain("insufficient_evidence");
    expect(raw.long.hasFreshnessGap).toBe(true);
    // Only 3 aligned timeframes; still meets minAlignedTfs=3 default IF
    // weighted score clears the bar. That's fine — the invariant is that
    // missing context did not silently vote for either side.
    expect(raw.long.alignedTfs).not.toContain("H4");
    expect(raw.short.state).toBe("none");
  });

  it("buildBothOpportunities preserves per-side lifecycle history", () => {
    const raw = evaluateDualDirection(BEARISH_STACK);
    const annotated = annotateWithPositionContext(raw, {
      hasOpenLongLadder: true,
      hasOpenShortLadder: false,
    });
    const now = "2026-07-21T14:00:00.000Z";
    const opps = buildBothOpportunities(
      "ADA-USDT",
      annotated,
      now,
      { firstDetectedAt: null, confirmedAt: null, weakenedAt: null, invalidatedAt: null },
      { firstDetectedAt: null, confirmedAt: null, weakenedAt: null, invalidatedAt: null },
    );
    expect(opps.short.state).toBe("confirmed");
    expect(opps.short.confirmedAt).toBe(now);
    expect(opps.short.firstDetectedAt).toBe(now);
    expect(opps.long.state).toBe("none");
    expect(opps.long.confirmedAt).toBeNull();
  });
});
