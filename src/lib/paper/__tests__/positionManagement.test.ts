import { describe, it, expect } from "vitest";
import {
  detectTriggers,
  synthesizeManagement,
  managementApplyEnabled,
  TP_APPROACH_FRACTION,
  type ManagedPosition,
  type ManagementMarket,
  buildManagementEvidence,
} from "../positionManagement.server";
import type { ProviderOutcome } from "@/lib/ai/committee/schema";

const pos: ManagedPosition = {
  id: "p1",
  symbol: "BTC-USDT",
  direction: "long",
  entryPrice: 100,
  sizeQty: 1,
  margin: 10,
  leverage: 10,
  stopLevel: 90,
  tpLevel: 120,
  structureBroken: false,
  filledRungCount: 1,
  configuredRungCount: 3,
  traceId: "t1",
  lastSeenCandleTsMs: 1_000,
};

const market: ManagementMarket = {
  price: 101,
  candleTsMs: 2_000,
  volume: 100,
  avgVolume: 100,
  recentCloses: [99, 100, 101],
  timeframeCloses: {
    close5mMs: 2_000, close15mMs: null, close1hMs: null, close4hMs: null,
    dailyMs: null, weeklyMs: null, monthlyMs: null,
  },
  environmentFrames: null,
};

function ok(role: string, direction: "long" | "short" | "no_trade", confidence = 0.7): ProviderOutcome {
  return {
    role,
    provider: role,
    model: `${role}-model`,
    available: true,
    latencyMs: 120,
    response: { direction, confidence, summary: `${role} says ${direction}`, risk_flags: [] },
  } as unknown as ProviderOutcome;
}
function down(role: string, reason = "timeout"): ProviderOutcome {
  return { role, provider: role, model: `${role}-model`, available: false, latencyMs: 5000, reason } as unknown as ProviderOutcome;
}

describe("position-management agent — triggers", () => {
  it("persists the complete closed-frame timestamp contract", () => {
    const evidence = buildManagementEvidence(pos, market, "candle_close");
    expect(evidence.timeframes).toEqual(market.timeframeCloses);
  });
  it("fires candle_close on a newer completed candle", () => {
    expect(detectTriggers(pos, market)).toContain("candle_close");
    expect(detectTriggers(pos, { ...market, candleTsMs: 500 })).not.toContain("candle_close");
  });

  it("fires tp_approach once price crosses the approach band", () => {
    const near = 100 + (120 - 100) * TP_APPROACH_FRACTION;
    expect(detectTriggers(pos, { ...market, price: near })).toContain("tp_approach");
    expect(detectTriggers(pos, { ...market, price: 105 })).not.toContain("tp_approach");
  });

  it("fires structure_break, rung_fill and volume_shift from deterministic state", () => {
    expect(detectTriggers({ ...pos, structureBroken: true }, market)).toContain("structure_break");
    expect(detectTriggers({ ...pos, filledRungCount: 2 }, market)).toContain("rung_fill");
    expect(detectTriggers(pos, { ...market, volume: 400 })).toContain("volume_shift");
  });

  it("fires hedge_opportunity on deep adverse excursion", () => {
    expect(detectTriggers(pos, { ...market, price: 93 })).toContain("hedge_opportunity");
  });
});

describe("position-management agent — ONYX synthesis", () => {
  it("holds in labeled AI-UNAVAILABLE mode when every seat fails — no deadlock", () => {
    const out = synthesizeManagement(pos, market, "candle_close", [down("lead"), down("risk"), down("structure")]);
    expect(out.action).toBe("HOLD");
    expect(out.rationale).toContain("AI-UNAVAILABLE");
  });

  it("continues in degraded 2/3 mode when one provider fails", () => {
    const out = synthesizeManagement(pos, market, "candle_close", [ok("lead", "long"), ok("risk", "long"), down("structure")]);
    expect(out.rationale).toContain("models 2/3");
    expect(out.action).toBe("HOLD");
  });

  it("banks profit when structure breaks while in profit", () => {
    const out = synthesizeManagement({ ...pos, structureBroken: true }, market, "structure_break", [ok("lead", "long")]);
    expect(out.action).toBe("BANK_PROFIT");
  });

  it("exits when structure breaks and models oppose the position", () => {
    const out = synthesizeManagement(
      { ...pos, structureBroken: true },
      { ...market, price: 95 },
      "structure_break",
      [ok("lead", "short"), ok("risk", "short"), ok("structure", "short")],
    );
    expect(out.action).toBe("EXIT");
  });

  it("moves to approved breakeven on a clean TP approach", () => {
    const out = synthesizeManagement(pos, { ...market, price: 118 }, "tp_approach", [
      ok("lead", "long"), ok("risk", "long"), ok("structure", "long"),
    ]);
    expect(out.action).toBe("MOVE_TO_APPROVED_BREAKEVEN");
  });

  it("only fills a rung that the approved ladder still has room for", () => {
    const room = synthesizeManagement(pos, market, "rung_fill", [ok("lead", "long"), ok("risk", "long")]);
    expect(room.action).toBe("FILL_APPROVED_RUNG");
    const exhausted = synthesizeManagement({ ...pos, filledRungCount: 3 }, market, "rung_fill", [ok("lead", "long")]);
    expect(exhausted.action).not.toBe("FILL_APPROVED_RUNG");
  });

  it("never emits an action outside the allowed paper set", () => {
    const allowed = new Set(["HOLD", "BANK_PROFIT", "FILL_APPROVED_RUNG", "MOVE_TO_APPROVED_BREAKEVEN", "HEDGE", "EXIT"]);
    for (const trigger of ["candle_close", "structure_break", "tp_approach", "hedge_opportunity", "rung_fill", "volume_shift"] as const) {
      for (const outcomes of [[ok("lead", "long")], [ok("lead", "short"), ok("risk", "short")], [down("lead")]]) {
        expect(allowed.has(synthesizeManagement(pos, market, trigger, outcomes).action)).toBe(true);
      }
    }
  });
});

describe("position-management agent — apply gate", () => {
  it("stays disabled unless explicitly enabled", () => {
    expect(managementApplyEnabled({})).toBe(false);
    expect(managementApplyEnabled({ PAPER_AGENTIC_MANAGEMENT_APPLY: "false" })).toBe(false);
    expect(managementApplyEnabled({ PAPER_AGENTIC_MANAGEMENT_APPLY: "true" })).toBe(true);
  });
});
