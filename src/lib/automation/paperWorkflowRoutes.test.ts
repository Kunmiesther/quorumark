import { describe, expect, it } from "vitest";
import {
  isIndependentPaperPlan,
  paperWorkflowRoutes,
} from "../../../supabase/functions/_shared/paper-workflow-routes";
import { authorizePaperCandidate } from "./paperAuthorization";

describe("independent paper routes", () => {
  const plan = {
    id: "paper-plan",
    enabled_turtles: ["accumulator", "vanguard", "sniper", "hunter", "arbiter"],
    proposal: {
      setupBook: "paper",
      paperRouteVersion: 1,
      venueAssignments: [
        { symbol: "BTC-USDT", connectionId: "aster" },
        { symbol: "ETH-USDT", connectionId: "apex" },
      ],
    },
  };
  it("authorizes all selected Turtle aliases against the saved plan", () => {
    const routes = paperWorkflowRoutes(plan);
    for (const detector of ["dca", "break-retest", "sweep", "liq-hunting", "funding-arb"])
      expect(authorizePaperCandidate(true, routes, "BTC-USDT", detector)).toMatchObject({
        allowed: true,
        route: { workflowId: plan.id, connectionId: "aster" },
      });
    expect(authorizePaperCandidate(true, routes, "SOL-USDT", "dca").allowed).toBe(false);
  });
  it("never treats a live plan or legacy plan as independently authorized", () => {
    expect(isIndependentPaperPlan({ ...plan.proposal, setupBook: "live" })).toBe(false);
    expect(paperWorkflowRoutes({ ...plan, proposal: {} })).toEqual([]);
  });
  it("takes Turtle selection from the locked workflow column, not stale proposal text", () => {
    const routes = paperWorkflowRoutes({ ...plan, enabled_turtles: ["hunter"] });
    expect(authorizePaperCandidate(true, routes, "BTC-USDT", "dca").allowed).toBe(false);
    expect(authorizePaperCandidate(true, routes, "BTC-USDT", "hunter").allowed).toBe(true);
  });
});
