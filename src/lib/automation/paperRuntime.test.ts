import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  evaluateAutopilotPaperRuntime,
  hasAutopilotLossLimitBreached,
  isAutopilotScheduleOpen,
} from "./paperRuntime.server";

const weekdayPlan = {
  schedule_enabled: true,
  active_days: [1, 2, 3, 4, 5],
  window_start: "09:30:00",
  window_end: "16:00:00",
  timezone: "America/New_York",
};

describe("Autopilot paper schedule", () => {
  it("opens inside a selected local-market window", () => {
    expect(isAutopilotScheduleOpen(weekdayPlan, new Date("2026-09-08T14:00:00Z"))).toBe(true);
  });

  it("closes outside the configured window", () => {
    expect(isAutopilotScheduleOpen(weekdayPlan, new Date("2026-09-08T22:00:00Z"))).toBe(false);
  });

  it("supports windows that cross midnight", () => {
    const overnight = {
      ...weekdayPlan,
      active_days: [2],
      window_start: "22:00:00",
      window_end: "03:00:00",
      timezone: "UTC",
    };
    expect(isAutopilotScheduleOpen(overnight, new Date("2026-09-08T23:30:00Z"))).toBe(true);
  });

  it("fails closed for an invalid timezone", () => {
    expect(isAutopilotScheduleOpen({ ...weekdayPlan, timezone: "not/a-zone" })).toBe(false);
  });

  it("trips the plan loss boundary on cumulative realized loss", () => {
    expect(hasAutopilotLossLimitBreached([-8, "-17"], 25)).toBe(true);
    expect(hasAutopilotLossLimitBreached([-8, 4], 25)).toBe(false);
  });
});

describe("paper runtime book isolation", () => {
  const plan = {
    ...weekdayPlan,
    id: "plan",
    status: "paper_validation",
    approved_at: "2026-09-01",
    loss_limit: 25,
    proposal: {},
  };
  function db(results: unknown[]) {
    const calls: unknown[][] = [];
    const from = vi.fn((table: string) => {
      calls.push(["from", table]);
      const result = results.shift();
      const q = {
        select: vi.fn(() => q),
        eq: vi.fn((...args: unknown[]) => {
          calls.push(["eq", ...args]);
          return q;
        }),
        neq: vi.fn(() => q),
        gte: vi.fn(() => q),
        in: vi.fn(() => q),
        order: vi.fn(() => q),
        range: vi.fn(() => q),
        update: vi.fn((value: unknown) => {
          calls.push(["update", value]);
          return q;
        }),
        insert: vi.fn((value: unknown) => {
          calls.push(["insert", value]);
          return q;
        }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve(result)),
      };
      return q;
    });
    const rpc = vi.fn((name: string, args: unknown) => {
      calls.push(["rpc", name, args]);
      return Promise.resolve(results.shift());
    });
    return { client: { from, rpc } as unknown as SupabaseClient, calls };
  }
  const ok = (data: unknown[]) => ({ data, error: null });
  it("runs an independent paper route beside the same symbol's live row without mutating it", async () => {
    const mock = db([
      ok([
        {
          ...plan,
          enabled_turtles: ["sniper", "vanguard"],
          proposal: {
            setupBook: "paper",
            paperRouteVersion: 1,
            venueAssignments: [{ connectionId: "venue", symbol: "BTC-USDT" }],
          },
        },
      ]),
      ok([
        {
          mode: "live",
          enabled: true,
          connection_id: "venue",
          symbol: "BTC-USDT",
          params: { autopilot_workflow_id: "live-plan" },
        },
      ]),
      ok([]),
    ]);
    const result = await evaluateAutopilotPaperRuntime(
      mock.client,
      "owner",
      new Date("2026-09-08T14:00:00Z"),
    );
    expect(result.routes).toEqual([
      {
        workflowId: "plan",
        connectionId: "venue",
        symbol: "BTC-USDT",
        turtles: ["sniper", "vanguard"],
      },
    ]);
    expect(mock.calls.some((c) => ["update", "insert", "rpc"].includes(String(c[0])))).toBe(false);
  });
  it("fails closed for a malformed independent route rather than using live rows", async () => {
    const mock = db([
      ok([
        {
          ...plan,
          enabled_turtles: ["sniper"],
          proposal: {
            setupBook: "paper",
            paperRouteVersion: 1,
            venueAssignments: [{ symbol: "BTC-USDT" }],
          },
        },
      ]),
      ok([]),
      ok([]),
    ]);
    expect(
      await evaluateAutopilotPaperRuntime(mock.client, "owner", new Date("2026-09-08T14:00:00Z")),
    ).toMatchObject({ controlled: true, shouldRun: false, reason: "lookup_failed" });
  });
  it.each([true, false])(
    "never evaluates or pauses a live-linked plan (enabled=%s)",
    async (enabled) => {
      const mock = db([
        ok([plan]),
        ok([{ mode: "live", enabled, params: { autopilot_workflow_id: "plan" } }]),
      ]);
      await evaluateAutopilotPaperRuntime(mock.client, "owner");
      expect(mock.calls.filter((c) => c[0] === "from")).toHaveLength(2);
      expect(mock.calls.some((c) => c[0] === "update")).toBe(false);
    },
  );
  it("does not assign unattributed account losses to a paper plan", async () => {
    const mock = db([ok([plan]), ok([]), ok([])]);
    const result = await evaluateAutopilotPaperRuntime(
      mock.client,
      "owner",
      new Date("2026-09-08T14:00:00Z"),
    );
    expect(result.shouldRun).toBe(true);
    expect(mock.calls).not.toContainEqual(["from", "paper_trades"]);
    expect(mock.calls.some((c) => c[0] === "update")).toBe(false);
  });
  it("pauses on attributed loss only and explicitly audits the paper book", async () => {
    const mock = db([
      ok([plan]),
      ok([]),
      ok([{ id: "p" }]),
      ok([{ pnl_net: -25, closed_at: "2026-09-02" }]),
      ok([{ id: "plan" }]),
      ok([]),
    ]);
    expect((await evaluateAutopilotPaperRuntime(mock.client, "owner")).shouldRun).toBe(false);
    expect(mock.calls).toContainEqual([
      "rpc",
      "control_autopilot_plan",
      {
        _user_id: "owner",
        _workflow_id: "plan",
        _action: "paper_loss_pause",
        _expected_status: "paper_validation",
      },
    ]);
  });
  it("does not publish a pause event when the status changed concurrently", async () => {
    const mock = db([
      ok([plan]),
      ok([]),
      ok([{ id: "p" }]),
      ok([{ pnl_net: -25, closed_at: "2026-09-02" }]),
      ok([]),
    ]);
    await evaluateAutopilotPaperRuntime(mock.client, "owner");
    expect(mock.calls.some((c) => c[0] === "insert")).toBe(false);
  });
  it("reports lookup failure without mutating a plan", async () => {
    const mock = db([ok([plan]), { data: null, error: { message: "offline" } }]);
    expect((await evaluateAutopilotPaperRuntime(mock.client, "owner")).reason).toBe(
      "lookup_failed",
    );
    expect(mock.calls.some((c) => c[0] === "update")).toBe(false);
  });
  it("returns only enabled paper routes from the plan whose schedule is open", async () => {
    const params = { autopilot_workflow_id: "plan", enabled_turtles: ["accumulator"] };
    const mock = db([
      ok([plan]),
      ok([
        {
          id: "r1",
          connection_id: "venue",
          symbol: "BTC-USDT",
          enabled: true,
          mode: "paper",
          params,
        },
        {
          id: "r2",
          connection_id: "venue",
          symbol: "ETH-USDT",
          enabled: false,
          mode: "paper",
          params,
        },
      ]),
      ok([]),
    ]);
    const result = await evaluateAutopilotPaperRuntime(
      mock.client,
      "owner",
      new Date("2026-09-08T14:00:00Z"),
    );
    expect(result.routes).toEqual([
      {
        workflowId: "plan",
        connectionId: "venue",
        symbol: "BTC-USDT",
        turtles: ["accumulator"],
      },
    ]);
  });
  it("does not revert to legacy entry authority when a plan is archived", async () => {
    const mock = db([ok([{ ...plan, status: "archived" }]), ok([])]);
    expect(await evaluateAutopilotPaperRuntime(mock.client, "owner")).toMatchObject({
      controlled: true,
      shouldRun: false,
      routes: [],
    });
  });
});
