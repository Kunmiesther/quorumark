import { describe, it, expect } from "vitest";
import { TURTLES } from "@/lib/turtles";

/** Squad-index guard: the page renders all six official strategy identities. */

const OFFICIAL_NAMES = new Set(["Vanguard", "Accumulator", "Arbiter", "Sniper", "Scout", "Hunter"]);

describe("Squad card source of truth", () => {
  it("Squad cards derive from exactly 6 TURTLES entries", () => {
    expect(TURTLES).toHaveLength(6);
  });

  it("every card name is one of the six official names", () => {
    for (const t of TURTLES) {
      expect(OFFICIAL_NAMES.has(t.name)).toBe(true);
    }
  });

  it("no card accent equals the data-cyan system color #22D3EE", () => {
    for (const t of TURTLES) {
      expect(t.accent.toUpperCase()).not.toBe("#22D3EE");
    }
  });

  it("Accumulator owns DCA and Arbiter owns funding-arb", () => {
    const accumulator = TURTLES.find((t) => t.name === "Accumulator");
    const arbiter = TURTLES.find((t) => t.name === "Arbiter");
    expect(accumulator?.slug).toBe("dca");
    expect(arbiter?.slug).toBe("funding-arb");
  });
});
