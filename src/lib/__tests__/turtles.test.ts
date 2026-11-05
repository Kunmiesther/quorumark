import { TURTLES, turtleByAnyKey } from "../turtles";
import { SUBSCRIPTION_TIERS } from "../subscription-tiers";
import { describe, it, expect } from "vitest";

const OFFICIAL_KEYS = ["vanguard", "accumulator", "sniper", "scout", "hunter", "arbiter"] as const;
const OFFICIAL_NAMES = ["Vanguard", "Accumulator", "Sniper", "Scout", "Hunter", "Arbiter"] as const;
const OFFICIAL_SUITS = [
  "The Vanguard",
  "The Accumulator",
  "The Sniper",
  "The Scout",
  "The Hunter",
  "The Arbiter",
] as const;
const OFFICIAL_SLUGS = [
  "break-retest",
  "dca",
  "rsi-divergence",
  "ema-cross",
  "liq-hunting",
  "funding-arb",
] as const;

const SYSTEM_COLORS = ["#A855F7", "#EF4444", "#F59E0B", "#10B981", "#22D3EE"];

describe("TURTLES catalog", () => {
  it("has exactly 6 entries", () => {
    expect(TURTLES).toHaveLength(6);
  });

  it("keys match the new canonical order", () => {
    expect(TURTLES.map((t) => t.key)).toEqual([...OFFICIAL_KEYS]);
  });

  it("names match the new canonical order", () => {
    expect(TURTLES.map((t) => t.name)).toEqual([...OFFICIAL_NAMES]);
  });

  it("suits match the new canonical order", () => {
    expect(TURTLES.map((t) => t.suit)).toEqual([...OFFICIAL_SUITS]);
  });

  it("slugs match the new canonical order", () => {
    expect(TURTLES.map((t) => t.slug)).toEqual([...OFFICIAL_SLUGS]);
  });

  it("has no name outside the official allowlist", () => {
    const allow = new Set<string>(OFFICIAL_NAMES);
    for (const t of TURTLES) expect(allow.has(t.name)).toBe(true);
  });

  it("has exactly one Arbiter", () => {
    const arbiters = TURTLES.filter((t) => t.name === "Arbiter");
    expect(arbiters).toHaveLength(1);
    expect(arbiters[0].slug).toBe("funding-arb");
  });

  it("every entry has non-empty image, tool, role, personality, bestConditions, biome, accent", () => {
    for (const t of TURTLES) {
      expect(t.image).toBeTruthy();
      expect(t.tool.length).toBeGreaterThan(0);
      expect(t.role.length).toBeGreaterThan(0);
      expect(t.personality.length).toBeGreaterThan(0);
      expect(t.bestConditions.length).toBeGreaterThan(0);
      expect(t.biome.length).toBeGreaterThan(0);
      expect(t.accent.length).toBeGreaterThan(0);
    }
  });

  it("risk values are constrained to low|medium|high", () => {
    const allowed = new Set(["low", "medium", "high"]);
    for (const t of TURTLES) expect(allowed.has(t.risk)).toBe(true);
  });

  it("no turtle accent collides with a system semantic color", () => {
    const forbidden = new Set(SYSTEM_COLORS.map((c) => c.toUpperCase()));
    for (const t of TURTLES) {
      expect(forbidden.has(t.accent.toUpperCase())).toBe(false);
      if (t.accentSoft) expect(forbidden.has(t.accentSoft.toUpperCase())).toBe(false);
    }
  });
});

describe("turtleByAnyKey", () => {
  it("canonical key 'accumulator' resolves to the Accumulator (dca slug)", () => {
    const t = turtleByAnyKey("accumulator");
    expect(t?.name).toBe("Accumulator");
    expect(t?.slug).toBe("dca");
  });

  it("canonical keys and strategy slugs resolve to the same entries", () => {
    expect(turtleByAnyKey("accumulator")).toBe(turtleByAnyKey("dca"));
    expect(turtleByAnyKey("arbiter")).toBe(turtleByAnyKey("funding-arb"));
    expect(turtleByAnyKey("hunter")).toBe(turtleByAnyKey("liq-hunting"));
  });

  it("is case-insensitive on the key", () => {
    expect(turtleByAnyKey("Accumulator")?.key).toBe("accumulator");
  });

  it("funding-arb resolves to the restored Arbiter", () => {
    expect(turtleByAnyKey("funding-arb")?.name).toBe("Arbiter");
  });

  it("returns null for unknown input", () => {
    expect(turtleByAnyKey("nope")).toBeNull();
    expect(turtleByAnyKey("")).toBeNull();
  });
});

describe("subscription tier guard", () => {
  it("subscription tiers are exactly ['free','ion','arc','orb','zen']", () => {
    expect([...SUBSCRIPTION_TIERS]).toEqual(["free", "ion", "arc", "orb", "zen"]);
  });

  it("no official turtle name is used as a subscription tier", () => {
    const tiers = new Set<string>(SUBSCRIPTION_TIERS.map((t) => t.toLowerCase()));
    for (const name of OFFICIAL_NAMES) {
      expect(tiers.has(name.toLowerCase())).toBe(false);
    }
  });
});
