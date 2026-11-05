// @vitest-environment node
import { describe, expect, it } from "vitest";
import { livePositionClosePatch, reconcileConnections } from "../../../../supabase/functions/_shared/live-position-close";

describe("venue-confirmed closure is not realized accounting", () => {
  it("clears stale marks and unrealized P&L while preserving strategy attribution", () => {
    const metadata = { origin: "bot", decision_id: "decision", strategy: "sweep" };
    const patch = livePositionClosePatch("2026-10-03T13:00:00Z", metadata);
    expect(patch).toMatchObject({ status: "closed", pnl_amount: null, pnl_pct: null, unrealized_pnl: null,
      current_price: null, mark_price: null, strategy_metadata: { ...metadata,
        closure_evidence: { realized_pnl_verified: false, source: "venue_flat_snapshot" } } });
    expect(metadata).toEqual({ origin: "bot", decision_id: "decision", strategy: "sweep" });
  });
  it("rejects invalid observation timestamps", () => {
    expect(() => livePositionClosePatch("invalid", null)).toThrow("INVALID_RECONCILIATION_TIME");
  });
  it("reads independent venues concurrently and isolates a failed route", async () => {
    let started = 0;
    let release!: () => void;
    const allStarted = new Promise<void>(resolve => { release = resolve; });
    const results = await reconcileConnections(["apex", "aster", "synfutures"], async venue => {
      if (++started === 3) release();
      await allStarted;
      if (venue === "aster") throw new Error("private-key");
      return venue + ":observed";
    }, venue => venue + ":unavailable", 3);
    expect(results).toEqual(["apex:observed", "aster:unavailable", "synfutures:observed"]);
  });
  it("returns an empty sweep without making any calls", async () => {
    expect(await reconcileConnections([], () => { throw new Error("must not run"); }, () => null)).toEqual([]);
  });
});
