import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DECISION_FRESHNESS_MS,
  decisionAgeMs,
  decisionChartOverlay,
  deriveFlowSteps,
  deriveSeats,
  flowHeadline,
  formatAge,
  parseDecisionRow,
  parseOpinionRow,
  reasonProse,
  type AiOpinion,
  type FlowWorkerHealth,
} from "@/lib/decision/decisionFlow";

const worker: FlowWorkerHealth = {
  state: "healthy",
  ready: true,
  workerId: "railway-turtlebot-primary",
  environment: "mainnet",
  mode: "live",
  reportedStatus: "healthy",
  version: "1",
  lastSeenAt: new Date().toISOString(),
  ageMs: 5_000,
  credentialsOk: true,
  reason: "ok",
};

const NOW = 1_700_000_000_000;
const CANDLE_CLOSE = new Date(NOW - 30_000).toISOString();

function decisionRow(overrides: Record<string, unknown> = {}) {
  return {
    decision_id: "dec_v1_" + "a".repeat(32),
    connection_id: "11111111-2222-3333-4444-555555555555",
    symbol: "ETH-USDT",
    strategy: "sweep",
    armed_leg: "sweep",
    timeframe: "5m",
    candle_close_at: CANDLE_CLOSE,
    direction: "wait",
    reason_code: "NO_CONFIRMED_ENTRY",
    reason: "No 1h liquidity sweep and retest",
    entry_zone: null,
    invalidation: null,
    take_profits: [],
    evidence_hash: "hash-a",
    execution_state: "not_reached",
    execution_reason_code: null,
    safety_checks: null,
    order_intent: null,
    apex_result: null,
    created_at: CANDLE_CLOSE,
    ...overrides,
  };
}

const SAFETY_PASS = {
  passed: true,
  block_code: null,
  block_detail: null,
  checks: [
    { key: "connection_verified", label: "Verified live connection and trading permission", passed: true },
    { key: "equity_usable", label: "Fresh, valid, usable equity", passed: true },
    { key: "no_conflicting_exposure", label: "No conflicting position, order or in-flight intent", passed: true },
    { key: "order_params_valid", label: "ApeX-valid size, price, leverage and margin", passed: true },
  ],
};

describe("decision row projection", () => {
  it("parses a WAIT decision as a real, complete decision", () => {
    const d = parseDecisionRow(decisionRow());
    expect(d).not.toBeNull();
    expect(d!.direction).toBe("wait");
    expect(d!.reason).toBe("No 1h liquidity sweep and retest");
  });

  it("returns null rather than a partial guess for a malformed row", () => {
    expect(parseDecisionRow({ decision_id: "x" })).toBeNull();
    expect(parseDecisionRow(undefined)).toBeNull();
  });
});

describe("flow steps", () => {
  it("a WAIT decision is DECIDED, and execution is 'not reached' — never 'rejected'", () => {
    const decision = parseDecisionRow(decisionRow())!;
    const steps = deriveFlowSteps({ worker, decision, nowMs: NOW });
    expect(steps.map((s) => s.key)).toEqual(["market", "decision", "safety", "apex"]);

    const [market, decisionStep, safety, apex] = steps;
    expect(market.status).toBe("green");
    // A WAIT is a completed decision, so it is green, not a warning state.
    expect(decisionStep.status).toBe("green");
    expect(decisionStep.headline).toBe("WAIT");
    expect(safety.status).toBe("gray");
    expect(safety.headline).toBe("Not reached");
    expect(apex.status).toBe("gray");
    expect(apex.headline).toBe("Not reached");
    // The banned wording must not appear anywhere in the projection.
    const text = JSON.stringify(steps).toLowerCase();
    expect(text).not.toContain("inactive");
    expect(text).not.toContain("no decision");
    expect(text).not.toContain("execution rejected");
  });

  it("renders the full path for a filled LONG", () => {
    const decision = parseDecisionRow(
      decisionRow({
        direction: "long",
        reason_code: "LONG_CONFIRMED",
        reason: "LONG confirmed on the newest 5m candle (accumulator)",
        strategy: "accumulator",
        entry_zone: { low: 3000, high: 3010 },
        invalidation: 2950,
        take_profits: [3100, 3150, 3200],
        execution_state: "filled",
        safety_checks: SAFETY_PASS,
        order_intent: { idempotency_key: "accum:c:ETHUSDT:long:1:2", side: "BUY", size: 0.05 },
        apex_result: { status: "submitted", exchange_order_id: "ex-1", exchange_status: "filled" },
      }),
    )!;
    const steps = deriveFlowSteps({ worker, decision, nowMs: NOW });
    expect(steps.map((s) => s.status)).toEqual(["green", "green", "green", "green"]);
    expect(steps[2].headline).toBe("All four passed");
    expect(steps[3].headline).toBe("Filled");
    expect(flowHeadline(decision)).toContain("LONG confirmed");
  });

  it("a failed safety check stops at SAFETY and ApeX stays 'not reached'", () => {
    const decision = parseDecisionRow(
      decisionRow({
        direction: "long",
        reason_code: "LONG_CONFIRMED",
        execution_state: "blocked",
        execution_reason_code: "EQUITY_BELOW_FLOOR",
        safety_checks: {
          passed: false,
          block_code: "EQUITY_BELOW_FLOOR",
          block_detail: "Usable equity below the 500 USD minimum",
          checks: [
            { key: "connection_verified", label: "Verified live connection and trading permission", passed: true },
            {
              key: "equity_usable",
              label: "Fresh, valid, usable equity",
              passed: false,
              code: "EQUITY_BELOW_FLOOR",
              detail: "Usable equity below the 500 USD minimum",
            },
            { key: "no_conflicting_exposure", label: "No conflicting position, order or in-flight intent", passed: null },
            { key: "order_params_valid", label: "ApeX-valid size, price, leverage and margin", passed: null },
          ],
        },
      }),
    )!;
    const steps = deriveFlowSteps({ worker, decision, nowMs: NOW });
    expect(steps[2].status).toBe("red");
    expect(steps[2].headline).toBe("EQUITY_BELOW_FLOOR");
    expect(steps[3].status).toBe("gray");
    expect(steps[3].headline).toBe("Not reached");
    // The two later checks are "not evaluated", never reported as passed.
    expect(decision.safety!.checks.filter((c) => c.passed === null)).toHaveLength(2);
  });

  it("marks a stale decision amber instead of pretending it is current", () => {
    const decision = parseDecisionRow(
      decisionRow({ candle_close_at: new Date(NOW - DECISION_FRESHNESS_MS - 1).toISOString() }),
    )!;
    const steps = deriveFlowSteps({ worker, decision, nowMs: NOW });
    expect(steps[0].status).toBe("amber");
    expect(decisionAgeMs(decision, NOW)).toBeGreaterThan(DECISION_FRESHNESS_MS);
  });
});

describe("AI seats", () => {
  const decision = parseDecisionRow(decisionRow({ direction: "long", reason_code: "LONG_CONFIRMED" }))!;

  function opinion(overrides: Partial<AiOpinion> & { role: AiOpinion["role"] }) {
    return parseOpinionRow({
      decision_id: decision.decisionId,
      role: overrides.role,
      provider: "openai",
      model: "openai/gpt-5.6-sol",
      status: overrides.status ?? "evaluated",
      direction: overrides.direction ?? "long",
      confidence: overrides.confidence ?? 0.7,
      summary: overrides.summary ?? "structure supports it",
      risk_flags: [],
      latency_ms: 900,
      prompt_version: "prompt.v1",
      evidence_hash: overrides.evidenceHash ?? decision.evidenceHash,
      unavailable_reason: overrides.unavailableReason ?? null,
      evaluated_at: CANDLE_CLOSE,
    })!;
  }

  it("distinguishes not-asked from asked-and-unavailable", () => {
    const seats = deriveSeats(decision, [opinion({ role: "lead" })]);
    expect(seats.find((s) => s.role === "lead")!.state).toBe("evaluated");
    // No row at all: the committee was never called. That is NOT "unavailable".
    expect(seats.find((s) => s.role === "risk")!.state).toBe("not_asked");
    expect(seats.find((s) => s.role === "structure")!.state).toBe("not_asked");
  });

  it("never converts an unavailable provider into agreement", () => {
    const down = parseOpinionRow({
      decision_id: decision.decisionId,
      role: "risk",
      provider: "deepseek",
      model: "claude-sonnet-5",
      status: "unavailable",
      direction: null,
      confidence: null,
      summary: null,
      risk_flags: [],
      latency_ms: 20_000,
      prompt_version: "prompt.v1",
      evidence_hash: decision.evidenceHash,
      unavailable_reason: "timeout",
      evaluated_at: CANDLE_CLOSE,
    })!;
    const seats = deriveSeats(decision, [down]);
    const risk = seats.find((s) => s.role === "risk")!;
    expect(risk.state).toBe("unavailable");
    expect(risk.agreesWithDecision).toBe(false);
    expect(risk.direction).toBeNull();
  });

  it("flags an opinion recorded against different evidence", () => {
    const seats = deriveSeats(decision, [opinion({ role: "lead", evidenceHash: "other-hash" } as never)]);
    expect(seats.find((s) => s.role === "lead")!.staleEvidence).toBe(true);
  });
});

describe("chart overlay", () => {
  it("draws entry, invalidation and every TP under the decision id", () => {
    const decision = parseDecisionRow(
      decisionRow({
        direction: "long",
        reason_code: "LONG_CONFIRMED",
        entry_zone: { low: 2990, high: 3010 },
        invalidation: 2950,
        take_profits: [3100, 3150, 3200],
      }),
    )!;
    const overlay = decisionChartOverlay(decision, "ETH-USDT")!;
    expect(overlay.key).toBe(`decision:${decision.decisionId}`);
    expect(overlay.entryLow).toBe(2990);
    expect(overlay.entryHigh).toBe(3010);
    expect(overlay.entry).toBe(3000);
    expect(overlay.invalidation).toBe(2950);
    // EVERY take profit, not just the first.
    expect(overlay.tps).toEqual([3100, 3150, 3200]);
  });

  it("draws nothing for a WAIT — there is no entry to show", () => {
    const decision = parseDecisionRow(decisionRow())!;
    expect(decisionChartOverlay(decision, "ETH-USDT")).toBeNull();
  });

  it("never draws one symbol's levels on another symbol's chart", () => {
    const decision = parseDecisionRow(
      decisionRow({ direction: "long", reason_code: "LONG_CONFIRMED", entry_zone: { low: 1, high: 2 } }),
    )!;
    expect(decisionChartOverlay(decision, "BTC-USDT")).toBeNull();
  });
});

describe("one decision id throughout the interface", () => {
  it("the panel, the headline and the chart all read the same id", () => {
    const decision = parseDecisionRow(
      decisionRow({
        direction: "long",
        reason_code: "LONG_CONFIRMED",
        entry_zone: { low: 2990, high: 3010 },
        execution_state: "submitted",
        safety_checks: SAFETY_PASS,
        apex_result: { status: "submitted", exchange_order_id: "ex-1", exchange_status: "accepted" },
      }),
    )!;
    const overlay = decisionChartOverlay(decision, "ETH-USDT")!;
    const seats = deriveSeats(decision, []);
    expect(overlay.key).toContain(decision.decisionId);
    expect(seats.every((s) => s.state === "not_asked")).toBe(true);
    // The flow steps are derived from this decision and no other source.
    const steps = deriveFlowSteps({ worker, decision, nowMs: NOW });
    expect(steps).toHaveLength(4);
    expect(flowHeadline(decision)).toContain("submitted");
  });
});

describe("prose helpers", () => {
  it("falls back to the machine code when no prose exists", () => {
    expect(reasonProse("BRAND_NEW_CODE", "")).toBe("BRAND_NEW_CODE");
    expect(reasonProse("NO_CONFIRMED_ENTRY", "")).toContain("No confirmed entry");
  });
  it("formats ages", () => {
    expect(formatAge(45_000)).toBe("45s ago");
    expect(formatAge(null)).toBe("—");
  });
});

/** Strip comments so a doc-comment mentioning "signer" is not a false hit. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("read-only AI boundary", () => {
  const forbidden = [/signer/i, /broker/i, /order_intents/, /submit_order/, /exchange_credentials/, /supabaseAdmin/];

  it("the shadow self-test imports no execution surface", () => {
    const src = code("src/lib/decision/shadowCheck.server.ts");
    for (const re of forbidden) expect(src).not.toMatch(re);
  });

  it("the decision-flow server functions perform no order writes", () => {
    const src = code("src/lib/decision/decisionFlow.functions.ts");
    expect(src).not.toMatch(/signer|broker|submit_order|supabaseAdmin/i);
    // The only insert is the diagnostic audit row.
    expect(src.match(/\.insert\(/g) ?? []).toHaveLength(1);
    expect(src).toContain('from("bot_events")');
    // It reads the LIVE worker's decisions, never the paper engine's events.
    expect(src).toContain('from("strategy_decisions")');
    expect(src).not.toContain("PAPER_TICK_REASONS");
  });

  it("the decision-keyed committee cannot reach execution", () => {
    const src = code("src/lib/ai/committee/decisionEvaluate.server.ts");
    for (const re of forbidden.filter((r) => !/supabaseAdmin/.test(r.source))) {
      expect(src).not.toMatch(re);
    }
    // It writes exactly one table, and it is the advisory ledger.
    expect(src).toContain("ai_decision_opinions");
    expect(src).not.toMatch(/\.update\(|\.delete\(/);
  });
});
