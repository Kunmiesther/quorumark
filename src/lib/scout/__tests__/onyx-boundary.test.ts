/**
 * Onyx boundary — Onyx execution code must not import Scout activation
 * mutators. It may read Scout intelligence only.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("scout: onyx boundary", () => {
  it("onyx decide.ts does not import scout activation mutators", () => {
    const src = readFileSync("src/lib/onyx/decide.ts", "utf8");
    expect(src.includes("setScoutPreference")).toBe(false);
    expect(src.includes("useScoutActivation")).toBe(false);
    expect(src.includes("runScoutScan")).toBe(false);
  });
});
