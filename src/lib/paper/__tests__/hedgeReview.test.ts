/**
 * Hedge-review tests — prove that Phase B open-book hedge decisions
 * fail closed on every pre-flight guard, and that negative PnL alone
 * is NEVER a trigger (regime is). Covers idempotency-friendly inputs
 * (cooldown), duplicate prevention (proposed_matches_open_direction),
 * insufficient margin, capability-unresolved venue, temporary
 * pullback / no hedge (non-opposing regime), and both close_and_reverse
 * + native_hedge success paths.
 */
import { describe, it, expect } from "vitest";
import {
  reviewHedgeForOpenPosition,
  HEDGE_COOLDOWN_MS,
  HEDGE_EXECUTION_ENABLED,
} from "../hedgeReview";
import type { MarketRegime } from "../../scout/regime";

const base = {
  positionId: "pos-1",
  symbol: "BTC-USDT",
  openDirection: "long" as const,
  proposedDirection: "short" as const,
  freshSignal: true,
  hasSufficientMargin: true,
  lastProposalAtMs: null as number | null,
  nowMs: 1_700_000_000_000,
};

describe("reviewHedgeForOpenPosition — trigger is regime, not PnL", () => {
  it("temporary pullback (developing_trend) → not_applicable", () => {
    const r = reviewHedgeForOpenPosition({
      ...base, regime: "developing_trend",
      hedgeSupported: true,
    });
    expect(r.status).toBe("not_applicable");
    if (r.status === "not_applicable") expect(r.reason).toBe("regime_not_opposing");
  });

  it("ranging regime (deep drawdown) → not_applicable", () => {
    const r = reviewHedgeForOpenPosition({
      ...base, regime: "ranging" as MarketRegime,
      hedgeSupported: true,
    });
    expect(r.status).toBe("not_applicable");
  });
});

describe("reviewHedgeForOpenPosition — pre-flight guards", () => {
  const opposing = { ...base, regime: "opposing_to_open_position" as MarketRegime };

  it("no opposing signal direction → not_applicable", () => {
    const r = reviewHedgeForOpenPosition({
      ...opposing, proposedDirection: null,
      hedgeSupported: false,
    });
    expect(r.status).toBe("not_applicable");
    if (r.status === "not_applicable") expect(r.reason).toBe("no_opposing_signal");
  });

  it("proposed matches open direction → not_applicable (duplicate prevention)", () => {
    const r = reviewHedgeForOpenPosition({
      ...opposing, proposedDirection: "long",
      hedgeSupported: false,
    });
    expect(r.status).toBe("not_applicable");
  });

  it("stale signal (freshSignal=false) → rejected stale_signal", () => {
    const r = reviewHedgeForOpenPosition({
      ...opposing, freshSignal: false, hedgeSupported: false,
    });
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason).toBe("stale_signal");
  });

  it("insufficient margin → rejected insufficient_margin", () => {
    const r = reviewHedgeForOpenPosition({
      ...opposing, hasSufficientMargin: false, hedgeSupported: false,
    });
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason).toBe("insufficient_margin");
  });

  it("cooldown active → rejected cooldown", () => {
    const r = reviewHedgeForOpenPosition({
      ...opposing, hedgeSupported: false,
      lastProposalAtMs: base.nowMs - HEDGE_COOLDOWN_MS + 1_000,
    });
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason).toBe("cooldown");
  });

  it("cooldown expired → passes cooldown guard", () => {
    const r = reviewHedgeForOpenPosition({
      ...opposing, hedgeSupported: false,
      lastProposalAtMs: base.nowMs - HEDGE_COOLDOWN_MS - 1,
    });
    expect(r.status).toBe("proposed");
  });

  it("venue capability unresolved (null) → rejected capability_unresolved_or_inconsistent", () => {
    const r = reviewHedgeForOpenPosition({
      ...opposing, hedgeSupported: null,
    });
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") {
      expect(r.reason).toBe("capability_unresolved_or_inconsistent");
      expect(r.plan?.action).toBe("hold_and_flag");
    }
  });
});

describe("reviewHedgeForOpenPosition — success paths", () => {
  const opposing = { ...base, regime: "opposing_to_open_position" as MarketRegime };

  it("venue supports hedge → proposed native_hedge", () => {
    const r = reviewHedgeForOpenPosition({ ...opposing, hedgeSupported: true });
    expect(r.status).toBe("proposed");
    if (r.status === "proposed") {
      expect(r.plan.action).toBe("native_hedge");
      expect(r.execute).toBe(HEDGE_EXECUTION_ENABLED);
    }
  });

  it("venue lacks hedge → proposed close_and_reverse", () => {
    const r = reviewHedgeForOpenPosition({ ...opposing, hedgeSupported: false });
    expect(r.status).toBe("proposed");
    if (r.status === "proposed") {
      expect(r.plan.action).toBe("close_and_reverse");
      expect(r.execute).toBe(HEDGE_EXECUTION_ENABLED);
    }
  });
});

describe("reviewHedgeForOpenPosition — execution boundary", () => {
  it("HEDGE_EXECUTION_ENABLED is enabled — live hedge execution armed", () => {
    expect(HEDGE_EXECUTION_ENABLED).toBe(true);
  });
});
