import { describe, expect, it } from "vitest";
import { authorizePaperCandidate } from "./paperAuthorization";
const route = {
  workflowId: "plan",
  connectionId: "exchange",
  symbol: "BTC-USDT",
  turtles: ["accumulator"],
};
describe("explicit paper plan routing", () => {
  it.each([
    ["sweep", "sniper"], ["dca", "accumulator"], ["break-retest", "vanguard"],
    ["liq-hunting", "hunter"], ["funding-arb", "arbiter"],
  ])("maps detector %s to configured Turtle %s", (detector, turtle) => {
    expect(authorizePaperCandidate(true, [{ ...route, turtles: [turtle] }], "BTC-USDT", detector).allowed).toBe(true);
  });
  it("binds a new eligible candidate to its exact configured route", () => {
    expect(authorizePaperCandidate(true, [route], "BTC-USDT", "accumulator").route).toEqual(route);
  });
  it("does not let another plan's active schedule authorize this symbol or Turtle", () => {
    expect(authorizePaperCandidate(true, [route], "ETH-USDT", "accumulator").allowed).toBe(false);
    expect(authorizePaperCandidate(true, [route], "BTC-USDT", "sniper").allowed).toBe(false);
    expect(authorizePaperCandidate(true, [], "BTC-USDT", "accumulator").allowed).toBe(false);
  });
  it("does not guess when two plans claim the same candidate", () => {
    expect(
      authorizePaperCandidate(
        true,
        [route, { ...route, workflowId: "other" }],
        "BTC-USDT",
        "accumulator",
      ).reason,
    ).toBe("ambiguous_plan_route");
  });
  it("keeps legacy entries explicitly unattributed", () => {
    expect(authorizePaperCandidate(false, [], "BTC-USDT", "accumulator")).toMatchObject({
      allowed: true,
      route: null,
    });
  });
});
