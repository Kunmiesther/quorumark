/**
 * Origin classification for reconciled live positions.
 *
 * The regression this locks: a position opened by the deterministic live path
 * (which writes `strategy_decisions` + `order_audit`, not `orders`) was being
 * labelled `venue_external` and losing its originating strategy and trace.
 */
import { describe, it, expect } from "vitest";
import { classifyOrigin, requireOriginReads } from "../../../../supabase/functions/_shared/position-origin";

describe("classifyOrigin", () => {
  it.each(["decisions", "audits", "orders"] as const)("does not treat a failed %s ledger read as empty", key => {
    const reads = {
      decisions: { data: [], error: null as unknown },
      audits: { data: [], error: null as unknown },
      orders: { data: [], error: null as unknown },
    };
    reads[key].error = { code: "42P01" };
    expect(() => requireOriginReads(reads)).toThrow("POSITION_ORIGIN_READ_FAILED");
  });
  it("requires successful array results but accepts genuinely empty ledgers", () => {
    const ok = { data: [], error: null };
    expect(requireOriginReads({ decisions: ok, audits: ok, orders: ok })).toEqual({ decisions: [], audits: [], orders: [] });
    expect(() => requireOriginReads({ decisions: ok, audits: ok, orders: { data: null, error: null } })).toThrow();
  });
  it("attributes a position to the strategy decision that opened it", () => {
    const out = classifyOrigin({
      side: "long",
      decisions: [
        {
          decision_id: "d-1",
          strategy: "sweep",
          trace_id: "t-1",
          direction: "long",
          execution_state: "filled",
        },
      ],
    });
    expect(out.origin).toBe("turtlebot");
    expect(out.strategy).toBe("sweep");
    expect(out.trace_id).toBe("t-1");
    expect(out.decision_id).toBe("d-1");
    expect(out.evidence).toBe("strategy_decision");
  });

  it("ignores a decision for the opposite direction", () => {
    const out = classifyOrigin({
      side: "long",
      decisions: [{ decision_id: "d-2", strategy: "sweep", direction: "short" }],
    });
    expect(out.origin).toBe("venue_external");
  });

  it("ignores WAIT decisions — they never opened anything", () => {
    const out = classifyOrigin({
      side: "long",
      decisions: [{ decision_id: "d-3", strategy: "sweep", direction: "wait" }],
    });
    expect(out.origin).toBe("venue_external");
  });

  it("falls back to broker audit evidence", () => {
    const out = classifyOrigin({
      side: "short",
      decisions: [],
      audits: [{ idempotency_key: "sweep:c:BTCUSDT:short:x", side: "SELL", phase: "submitted" }],
    });
    expect(out.origin).toBe("turtlebot");
    expect(out.evidence).toBe("order_audit");
    expect(out.idempotency_key).toBe("sweep:c:BTCUSDT:short:x");
  });

  it("still honours the legacy orders table", () => {
    const out = classifyOrigin({ side: "long", orders: [{ id: "o-1" }] });
    expect(out.origin).toBe("turtlebot");
    expect(out.evidence).toBe("orders");
  });

  it("labels a genuinely manual venue position as external", () => {
    const out = classifyOrigin({ side: "long", decisions: [], audits: [], orders: [] });
    expect(out.origin).toBe("venue_external");
    expect(out.strategy).toBeNull();
    expect(out.trace_id).toBeNull();
  });
});
