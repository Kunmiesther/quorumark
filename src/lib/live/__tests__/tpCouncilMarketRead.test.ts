import { describe, expect, it } from "vitest";
import {
  apexVenueGeometry,
  freshlyReconciledConnections,
  marketReadConsensus,
  priorReviewFeedback,
  reduceOnlyReviewPayload,
  synthesize,
  type SeatOpinion,
} from "../tpCouncil.server";

it("retains the position's exchange on reduce-only review exits", () => {
  for (const venue of ["aster", "apex_omni"] as const) {
    expect(
      reduceOnlyReviewPayload({
        venue,
        user_id: "owner",
        connection_id: "connection",
        symbol: "ETH-USDT",
        side: "SELL",
        order_type: "MARKET",
        size: "0.01",
        price: null,
        idempotency_key: "review-1",
      }),
    ).toMatchObject({
      venue,
      connection_id: "connection",
      reduce_only: true,
      size: 0.01,
      purpose: "CLOSE_POSITION",
    });
  }
});

function seat(market_state: SeatOpinion["market_state"], available = true): SeatOpinion {
  return {
    role: "structure",
    model: "test",
    available,
    decision: "HOLD_WITHOUT_TP",
    price: null,
    size_fraction: null,
    trail_pct: null,
    confidence: 0.7,
    market_state,
    rationale: "Evidence-based review",
    latency_ms: 1,
  };
}

describe("live Council market read", () => {
  it("requires a majority before presenting a reversal", () => {
    expect(marketReadConsensus([seat("REVERSAL"), seat("REVERSAL"), seat("PULLBACK")])).toBe(
      "REVERSAL",
    );
    expect(marketReadConsensus([seat("REVERSAL"), seat("PULLBACK"), seat("UNCLEAR")])).toBe(
      "UNCLEAR",
    );
  });

  it("does not count unavailable seats", () => {
    expect(marketReadConsensus([seat("PULLBACK"), seat("REVERSAL", false)])).toBe("PULLBACK");
    expect(marketReadConsensus([seat(null, false)])).toBe("UNCLEAR");
  });
});

describe("live take-profit venue increments", () => {
  const response = {
    data: {
      contractConfig: {
        perpetualContract: [
          { symbol: "ETH-USDT", tickSize: "0.01", stepSize: "0.001", minOrderSize: "0.01" },
        ],
      },
    },
  };

  it("uses the matching contract's actual increments and minimum", () => {
    expect(apexVenueGeometry(response, "ETH-USDT")).toEqual({
      tickSize: 0.01,
      stepSize: 0.001,
      minOrderSize: 0.01,
      minNotional: undefined,
    });
  });

  it("fails closed when a contract or required increment is missing", () => {
    expect(apexVenueGeometry(response, "BTC-USDT")).toBeNull();
    expect(
      apexVenueGeometry(
        {
          data: {
            contractConfig: { perpetualContract: [{ symbol: "ETH-USDT", tickSize: "0.01" }] },
          },
        },
        "ETH-USDT",
      ),
    ).toBeNull();
  });
});

describe("within-trade review feedback", () => {
  const previous = {
    review_seq: 2,
    decision: "HOLD_WITHOUT_TP",
    rationale: "Structure remains intact",
    completed_at: "2026-09-19T12:00:00Z",
    venue_order_id: null,
    council_inputs: { mark_price: 100, market_read: "PULLBACK" },
  };

  it("shows favorable price movement relative to position direction", () => {
    expect(priorReviewFeedback(previous, 102, "long")?.favorable_move_pct).toBe(2);
    expect(priorReviewFeedback(previous, 102, "short")?.favorable_move_pct).toBe(-2);
  });

  it("does not invent feedback when the prior mark is missing", () => {
    expect(
      priorReviewFeedback({ ...previous, council_inputs: {} }, 102, "long")?.favorable_move_pct,
    ).toBeNull();
    expect(priorReviewFeedback(null, 102, "long")).toBeNull();
  });
});

describe("live Council order quorum", () => {
  const vote = (decision: SeatOpinion["decision"], role: string): SeatOpinion => ({
    ...seat("UNCLEAR"),
    role,
    decision,
    rationale: `${role} voted ${decision}`,
  });

  it("does not liquidate a position on one seat's exit vote", () => {
    const outcome = synthesize([
      vote("EXIT_NOW", "risk"),
      vote("HOLD_WITHOUT_TP", "lead"),
      vote("HOLD_WITHOUT_TP", "structure"),
    ]);
    expect(outcome.decision).toBe("HOLD_WITHOUT_TP");
    expect(outcome.degraded).toBe(true);
  });

  it("requires two independent exit votes", () => {
    const outcome = synthesize([
      vote("EXIT_NOW", "risk"),
      vote("EXIT_NOW", "structure"),
      vote("HOLD_WITHOUT_TP", "lead"),
    ]);
    expect(outcome.decision).toBe("EXIT_NOW");
  });

  it("does not place an order with only one available seat", () => {
    const unavailable = { ...vote("SET_TP", "lead"), available: false };
    const outcome = synthesize([vote("EXIT_NOW", "risk"), unavailable]);
    expect(outcome.decision).toBe("HOLD_WITHOUT_TP");
    expect(outcome.degraded).toBe(true);
  });
});

describe("venue reconciliation authorizes orders only with complete evidence", () => {
  it("allows risk-reducing management on a fresh complete snapshot despite uncertain historic entries", () => {
    const result = freshlyReconciledConnections({ results: [
      { connection_id: "fresh-exposure", ok: false, position_snapshot_ok: true, open_orders_readable: true, order_reconciliation_required: true },
      { connection_id: "failed-orders", ok: false, position_snapshot_ok: true, open_orders_readable: false },
    ] });
    expect([...result]).toEqual(["fresh-exposure"]);
  });
  it("accepts only a fresh successful position and open-order read", () => {
    const connections = freshlyReconciledConnections({
      results: [
        { connection_id: "ready", ok: true, open_orders_readable: true },
        { connection_id: "orders_failed", ok: false, open_orders_readable: false },
        { connection_id: "in_flight", ok: true, skipped: "cycle_already_running" },
        { connection_id: "legacy", ok: true },
      ],
    });
    expect([...connections]).toEqual(["ready"]);
  });

  it("fails closed on a missing or malformed response", () => {
    expect(freshlyReconciledConnections(null).size).toBe(0);
    expect(freshlyReconciledConnections({ results: null }).size).toBe(0);
  });
});
