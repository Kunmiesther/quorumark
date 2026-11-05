/**
 * Paper dual-direction eligibility gate regressions.
 * Every ineligible reason must be returned deterministically and NEVER
 * accompanied by any implicit modification of the original ladder.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateDualDirectionEligibility,
  DEFAULT_DUAL_DIRECTION_SETTINGS,
  type GateInput,
  type UserDualDirectionSettings,
} from "../dualDirectionGate";
import { PAPER_VENUE, venueCapability } from "@/lib/exchanges/venueCapabilities";
import type { ScoutOpportunity } from "@/lib/scout/opportunity";

const CONFIRMED_SHORT: ScoutOpportunity = {
  symbol: "ADA-USDT",
  side: "short",
  state: "confirmed",
  confidence: 0.62,
  fresh: true,
  supportingTimeframes: ["H4", "H1", "M15"],
  reasonCodes: ["ema_stack_down"],
  firstDetectedAt: "2026-07-21T14:00:00Z",
  confirmedAt: "2026-07-21T14:05:00Z",
  weakenedAt: null,
  invalidatedAt: null,
};

const ENABLED_SETTINGS: UserDualDirectionSettings = {
  enabled: true,
  maxOppositeMarginUsd: 60,
  maxSymbolMarginUsd: 200,
};

function baseInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    opportunity: CONFIRMED_SHORT,
    openPositionsForSymbol: [
      { positionId: "pos-long-1", side: "long", walletKey: "ADA-long", marginUsd: 60 },
    ],
    walletsForSymbol: [
      { walletKey: "ADA-long", side: "long", enabled: true },
      { walletKey: "ADA-short", side: "short", enabled: true },
    ],
    userSettings: ENABLED_SETTINGS,
    venue: PAPER_VENUE,
    proposedOppositeMarginUsd: 60,
    ...overrides,
  };
}

describe("evaluateDualDirectionEligibility", () => {
  it.each(["apex_omni","aster"])("does not infer independent hedge accounts from %s UI wallets",venue=>{
    expect(evaluateDualDirectionEligibility(baseInput({venue:venueCapability(venue)})).reason).toBe("NETTING_CONFLICT");
  });
  // 4. DUAL_DIRECTION_OFF → detected but not executable, no order intent.
  it("returns DUAL_DIRECTION_OFF when the feature is disabled (default)", () => {
    const d = evaluateDualDirectionEligibility(
      baseInput({ userSettings: DEFAULT_DUAL_DIRECTION_SETTINGS }),
    );
    expect(d.reason).toBe("DUAL_DIRECTION_OFF");
    expect(d.eligible).toBe(false);
  });

  // 5. Hedge-capable venue + separate wallet → ELIGIBLE. Gate is pure so
  //    verifying ELIGIBLE is sufficient — the engine's job is to open
  //    the separate position; the gate does not mutate anything.
  it("returns ELIGIBLE for hedge venue + separate opposite wallet", () => {
    const d = evaluateDualDirectionEligibility(baseInput());
    expect(d.reason).toBe("ELIGIBLE");
    expect(d.eligible).toBe(true);
  });

  // 6. One-way venue → NETTING_CONFLICT, never ELIGIBLE.
  it("returns NETTING_CONFLICT on a one-way venue", () => {
    const oneWay = venueCapability("some_unknown_venue"); // fails closed to one_way
    expect(oneWay.hedgeMode).toBe("one_way");
    const d = evaluateDualDirectionEligibility(baseInput({ venue: oneWay }));
    expect(d.reason).toBe("NETTING_CONFLICT");
    expect(d.eligible).toBe(false);
  });

  it("returns NO_OPPOSITE_WALLET when the SHORT wallet is missing or disabled", () => {
    const d1 = evaluateDualDirectionEligibility(
      baseInput({
        walletsForSymbol: [
          { walletKey: "ADA-long", side: "long", enabled: true },
        ],
      }),
    );
    expect(d1.reason).toBe("NO_OPPOSITE_WALLET");
    const d2 = evaluateDualDirectionEligibility(
      baseInput({
        walletsForSymbol: [
          { walletKey: "ADA-long", side: "long", enabled: true },
          { walletKey: "ADA-short", side: "short", enabled: false },
        ],
      }),
    );
    expect(d2.reason).toBe("NO_OPPOSITE_WALLET");
  });

  it("returns SAME_SIDE_ALREADY_OPEN when a short ladder already exists", () => {
    const d = evaluateDualDirectionEligibility(
      baseInput({
        openPositionsForSymbol: [
          { positionId: "pos-long-1", side: "long", walletKey: "ADA-long", marginUsd: 60 },
          { positionId: "pos-short-1", side: "short", walletKey: "ADA-short", marginUsd: 60 },
        ],
      }),
    );
    expect(d.reason).toBe("SAME_SIDE_ALREADY_OPEN");
  });

  it("returns RISK_CAP when the opposite trade breaches per-opposite or per-symbol ceilings", () => {
    // per-opposite cap breach
    const dPer = evaluateDualDirectionEligibility(
      baseInput({
        userSettings: { ...ENABLED_SETTINGS, maxOppositeMarginUsd: 30 },
        proposedOppositeMarginUsd: 60,
      }),
    );
    expect(dPer.reason).toBe("RISK_CAP");

    // per-symbol combined cap breach (existing long 60 + proposed short 60 > 100)
    const dSym = evaluateDualDirectionEligibility(
      baseInput({
        userSettings: { ...ENABLED_SETTINGS, maxSymbolMarginUsd: 100 },
      }),
    );
    expect(dSym.reason).toBe("RISK_CAP");
  });

  // 8. STALE and WEAK short-circuit early — no order intent.
  it("returns STALE / WEAK before any other check runs", () => {
    const stale = evaluateDualDirectionEligibility(
      baseInput({ opportunity: { ...CONFIRMED_SHORT, fresh: false } }),
    );
    expect(stale.reason).toBe("STALE");
    const weak = evaluateDualDirectionEligibility(
      baseInput({ opportunity: { ...CONFIRMED_SHORT, state: "watching" } }),
    );
    expect(weak.reason).toBe("WEAK");
    const noneState = evaluateDualDirectionEligibility(
      baseInput({ opportunity: { ...CONFIRMED_SHORT, state: "none" } }),
    );
    expect(noneState.reason).toBe("WEAK");
  });

  // Isolation: the gate is pure — it never mutates its inputs, so the
  // original ladder's summary bytes are stable across a full ELIGIBLE
  // evaluation. This is the structural guarantee that Test 5 in the
  // acceptance list wants (opposite trade never touches the original).
  it("does not mutate the original ladder summary or any input array", () => {
    const input = baseInput();
    const snapshot = JSON.stringify(input);
    evaluateDualDirectionEligibility(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
