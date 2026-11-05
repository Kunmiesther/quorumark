import { describe, expect, it, vi } from "vitest";
import {
  hasLiveExecutionRows,
  readWorkflowPaperEvidence,
} from "../../../supabase/functions/_shared/autopilot-paper-evidence";

function reader(results: Array<{ data: Record<string, unknown>[] | null; error: unknown }>) {
  const calls: unknown[][] = [];
  const from = vi.fn((table: string) => {
    calls.push(["from", table]);
    const result = results.shift();
    const q = {
      select: vi.fn((...args: unknown[]) => {
        calls.push(["select", ...args]);
        return q;
      }),
      eq: vi.fn((...args: unknown[]) => {
        calls.push(["eq", ...args]);
        return q;
      }),
      in: vi.fn((...args: unknown[]) => {
        calls.push(["in", ...args]);
        return q;
      }),
      gte: vi.fn((...args: unknown[]) => {
        calls.push(["gte", ...args]);
        return q;
      }),
      order: vi.fn(() => q),
      range: vi.fn(() => q),
      then: (resolve: (value: typeof result) => unknown) => Promise.resolve(resolve(result)),
    };
    return q;
  });
  return {
    client: { from } as unknown as Parameters<typeof readWorkflowPaperEvidence>[0],
    calls,
    from,
  };
}
describe("plan-scoped paper evidence", () => {
  it("recognizes live rows even for legacy paper-origin or disabled mandates", () => {
    expect(hasLiveExecutionRows({ setupBook: "live" }, [])).toBe(true);
    expect(hasLiveExecutionRows({}, [{ mode: "live" }])).toBe(true);
    expect(hasLiveExecutionRows({}, [{ mode: "paper" }])).toBe(false);
  });
  it("never queries all account trades when plan attribution is missing", async () => {
    const db = reader([{ data: [], error: null }]);
    expect(await readWorkflowPaperEvidence(db.client, "owner", "plan", "date")).toEqual([]);
    expect(db.from).toHaveBeenCalledTimes(1);
    expect(db.calls).toContainEqual(["eq", "strategy_metadata->>autopilot_workflow_id", "plan"]);
    expect(db.calls).toContainEqual(["eq", "user_id", "owner"]);
  });
  it("scopes both reads to owner and trades to exact position IDs, returning chronological P&L", async () => {
    const db = reader([
      { data: [{ id: "position" }], error: null },
      {
        data: [
          { pnl_net: "-2", closed_at: "2026-09-02" },
          { pnl_net: 3, closed_at: "2026-09-01" },
        ],
        error: null,
      },
    ]);
    expect(await readWorkflowPaperEvidence(db.client, "owner", "plan", "approved")).toEqual([
      { pnl_net: 3, closed_at: "2026-09-01" },
      { pnl_net: -2, closed_at: "2026-09-02" },
    ]);
    expect(db.calls.filter((c) => c[0] === "eq" && c[1] === "user_id")).toHaveLength(2);
    expect(db.calls).toContainEqual(["in", "position_id", ["position"]]);
    expect(db.calls).toContainEqual(["gte", "closed_at", "approved"]);
  });
  it.each([null, "invalid", ""])("does not turn missing/invalid P&L %s into zero", async (pnl) => {
    const db = reader([
      { data: [{ id: "p" }], error: null },
      { data: [{ pnl_net: pnl }], error: null },
    ]);
    await expect(readWorkflowPaperEvidence(db.client, "u", "p", "date")).rejects.toThrow(
      "P&L is unavailable",
    );
  });
  it("propagates evidence lookup failures rather than inventing a zero loss", async () => {
    const db = reader([{ data: null, error: { message: "unavailable" } }]);
    await expect(readWorkflowPaperEvidence(db.client, "u", "p", "date")).rejects.toThrow(
      "attribution",
    );
  });
  it("paginates attribution rather than truncating it to the API limit", async () => {
    const db = reader([
      { data: Array.from({ length: 500 }, (_, i) => ({ id: `p${i}` })), error: null },
      { data: [{ id: "p500" }], error: null },
      ...Array.from({ length: 6 }, () => ({ data: [], error: null })),
    ]);
    await readWorkflowPaperEvidence(db.client, "u", "plan", "date");
    expect(db.from).toHaveBeenCalledTimes(8);
    expect(db.calls).toContainEqual(["in", "position_id", ["p500"]]);
  });
});
