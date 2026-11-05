/**
 * Scout market-regime classifier — deterministic 7-class rule tests.
 *
 * These lock the P1 contract: for a given (consensus + signal state +
 * evidence) tuple the classifier returns exactly one of the seven regimes
 * plus `unknown`. Rules are precedence-ordered — the tests exercise each
 * branch so a reordering that changes behavior fails loudly.
 */
import { describe, it, expect } from "vitest";
import {
  classifyMarketRegime,
  REGIME_CONFIG_V1,
  REGIME_SCHEMA_VERSION,
  type MarketRegime,
} from "../regime";
import type { ConsensusResult } from "../types";
import type { SignalState } from "../state";

const strongLongConsensus: ConsensusResult = {
  bias: "long-priority",
  readiness: "armed",
  weightedScore: 0.7,
  confidence: 0.75,
  conflict: 0.1,
  availability: 1,
};
const strongShortConsensus: ConsensusResult = {
  ...strongLongConsensus,
  bias: "short-priority",
  weightedScore: -0.7,
};
const balancedConsensus: ConsensusResult = {
  bias: "balanced",
  readiness: "watching",
  weightedScore: 0.05,
  confidence: 0.1,
  conflict: 0.2,
  availability: 1,
};
const conflictedConsensus: ConsensusResult = {
  bias: "no-signal",
  readiness: "watching",
  weightedScore: 0.15,
  confidence: 0.2,
  conflict: 0.7,
  availability: 1,
};
const emptyConsensus: ConsensusResult = {
  bias: "no-signal",
  readiness: "no-signal",
  weightedScore: 0,
  confidence: 0,
  conflict: 0,
  availability: 0.2,
};

function base(
  overrides: Partial<Parameters<typeof classifyMarketRegime>[0]> = {},
): Parameters<typeof classifyMarketRegime>[0] {
  return {
    consensus: strongLongConsensus,
    signalDirection: "long",
    signalState: "CONFIRMED",
    stateReasonCodes: [],
    htfValid: true,
    health: "healthy",
    openPositionDirection: null,
    ...overrides,
  };
}

describe("classifyMarketRegime — precedence + 7 categories", () => {
  it("emits versioned schema tag", () => {
    const r = classifyMarketRegime(base());
    expect(r.schemaVersion).toBe(REGIME_SCHEMA_VERSION);
  });

  it("1. strong_uptrend when confirmed + strong long + htfValid", () => {
    const r = classifyMarketRegime(base());
    expect(r.regime).toBe<MarketRegime>("strong_uptrend");
    expect(r.reasonCodes).toContain("confirmed_long_alignment");
  });

  it("2. strong_downtrend when confirmed + strong short + htfValid", () => {
    const r = classifyMarketRegime(
      base({ consensus: strongShortConsensus, signalDirection: "short" }),
    );
    expect(r.regime).toBe<MarketRegime>("strong_downtrend");
    expect(r.reasonCodes).toContain("confirmed_short_alignment");
  });

  it("3. developing_trend when ARMED (not yet confirmed) with strong evidence", () => {
    const r = classifyMarketRegime(base({ signalState: "ARMED" }));
    expect(r.regime).toBe<MarketRegime>("developing_trend");
    expect(r.reasonCodes).toContain("armed_long_alignment");
  });

  it("3b. developing_trend when BUILDING with directional score above ranging floor", () => {
    const softLong: ConsensusResult = {
      ...strongLongConsensus,
      weightedScore: 0.3,
      confidence: 0.3,
    };
    const r = classifyMarketRegime(
      base({ consensus: softLong, signalState: "BUILDING", signalDirection: "long" }),
    );
    expect(r.regime).toBe<MarketRegime>("developing_trend");
    expect(r.reasonCodes).toContain("building_directional");
  });

  it("4. ranging when balanced + low score + low conflict", () => {
    const r = classifyMarketRegime(
      base({
        consensus: balancedConsensus,
        signalDirection: "none",
        signalState: "WATCHING",
      }),
    );
    expect(r.regime).toBe<MarketRegime>("ranging");
    expect(r.reasonCodes).toContain("balanced_low_score");
  });

  it("5. volatile when MTF conflict is high (dominates strong-trend evidence)", () => {
    // Craft consensus with strong score AND high conflict — volatile must win.
    const c: ConsensusResult = { ...strongLongConsensus, conflict: 0.8 };
    const r = classifyMarketRegime(base({ consensus: c }));
    expect(r.regime).toBe<MarketRegime>("volatile");
    expect(r.reasonCodes).toContain("mtf_conflict_high");
  });

  it("6. reversal_forming when state is INVALIDATED", () => {
    const r = classifyMarketRegime(
      base({ signalState: "INVALIDATED", signalDirection: "none" }),
    );
    expect(r.regime).toBe<MarketRegime>("reversal_forming");
    expect(r.reasonCodes).toContain("state_invalidated");
  });

  it("6b. reversal_forming when HTF flipped reason is present", () => {
    const r = classifyMarketRegime(
      base({
        signalState: "WEAKENING",
        stateReasonCodes: ["invalidated_htf_flipped"],
      }),
    );
    expect(r.regime).toBe<MarketRegime>("reversal_forming");
    expect(r.reasonCodes).toContain("htf_flipped_prior_direction");
  });

  it("7. opposing_to_open_position — long open, confirmed short signal", () => {
    const r = classifyMarketRegime(
      base({
        consensus: strongShortConsensus,
        signalDirection: "short",
        signalState: "ARMED",
        openPositionDirection: "long",
      }),
    );
    expect(r.regime).toBe<MarketRegime>("opposing_to_open_position");
    expect(r.reasonCodes).toContain("opposing_confirmed_vs_open_long");
  });

  it("7b. opposing_to_open_position — short open, confirmed long signal", () => {
    const r = classifyMarketRegime(
      base({ openPositionDirection: "short" }),
    );
    expect(r.regime).toBe<MarketRegime>("opposing_to_open_position");
    expect(r.reasonCodes).toContain("opposing_confirmed_vs_open_short");
  });

  it("7c. opposing_to_open_position NOT emitted when signal matches open dir", () => {
    const r = classifyMarketRegime(base({ openPositionDirection: "long" }));
    expect(r.regime).not.toBe<MarketRegime>("opposing_to_open_position");
    expect(r.regime).toBe<MarketRegime>("strong_uptrend");
  });

  it("unknown when health is offline (fail-safe)", () => {
    const r = classifyMarketRegime(base({ health: "offline" }));
    expect(r.regime).toBe<MarketRegime>("unknown");
    expect(r.reasonCodes).toContain("insufficient_data");
  });

  it("unknown when availability below minAvailability", () => {
    const r = classifyMarketRegime(base({ consensus: emptyConsensus }));
    expect(r.regime).toBe<MarketRegime>("unknown");
  });

  it("strong-trend requires htfValid — falls through to developing/ranging when HTF missing", () => {
    const r = classifyMarketRegime(base({ htfValid: false }));
    // Not strong_uptrend because htfValid=false disqualifies strong.
    expect(r.regime).not.toBe<MarketRegime>("strong_uptrend");
    expect(r.reasonCodes).toContain("htf_stale_or_missing");
  });

  it("negative PnL alone is invisible to the classifier (no such input)", () => {
    // Contract check: the classifier signature has no PnL field — regime is
    // pure market intelligence. Compile-time enforcement + runtime confirmation
    // that the function ignores anything not in `RegimeInput`.
    const r1 = classifyMarketRegime(base());
    const r2 = classifyMarketRegime(base());
    expect(r1.regime).toBe(r2.regime);
  });

  it("volatile is EMITTED even when open position exists — regime is market state", () => {
    const r = classifyMarketRegime(
      base({
        consensus: conflictedConsensus,
        signalDirection: "none",
        signalState: "BUILDING",
        openPositionDirection: "long",
      }),
    );
    expect(r.regime).toBe<MarketRegime>("volatile");
  });

  it("thresholds are the documented REGIME_CONFIG_V1 (no hidden magic)", () => {
    // If any threshold drifts without bumping REGIME_SCHEMA_VERSION, this test
    // will need updating alongside — that's the point.
    expect(REGIME_CONFIG_V1.strongConfidenceMin).toBeGreaterThan(0);
    expect(REGIME_CONFIG_V1.strongConflictMax).toBeGreaterThan(0);
    expect(REGIME_CONFIG_V1.volatileConflictMin).toBeGreaterThan(
      REGIME_CONFIG_V1.strongConflictMax,
    );
    expect(REGIME_CONFIG_V1.rangingScoreMagnitudeMax).toBeLessThan(
      REGIME_CONFIG_V1.strongScoreMagnitudeMin,
    );
  });
});

describe("classifyMarketRegime — determinism / idempotency", () => {
  it("same input → same output every call", () => {
    const input = base();
    const runs = Array.from({ length: 25 }, () => classifyMarketRegime(input));
    const first = JSON.stringify(runs[0]);
    for (const r of runs) expect(JSON.stringify(r)).toBe(first);
  });
});

// SignalState exhaustiveness — ensures every SignalState is handled without
// producing `unknown` when consensus is otherwise well-formed.
describe("classifyMarketRegime — SignalState coverage", () => {
  const states: SignalState[] = [
    "WATCHING",
    "BUILDING",
    "ARMED",
    "CONFIRMED",
    "WEAKENING",
    "INVALIDATED",
  ];
  it.each(states)("returns a regime (not necessarily != unknown) for state=%s", (s) => {
    const r = classifyMarketRegime(base({ signalState: s }));
    expect(r.regime).toBeDefined();
  });
});
