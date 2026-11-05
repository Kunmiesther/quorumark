import { describe, expect, it } from "vitest";
import { effectiveTp } from "../effectiveTp";

describe("effectiveTp — FIX 1 TP mismatch", () => {
  it("long: uses tp_level when it is nearer (lower) than lot.tp", () => {
    // DOGE regression: strategy target 0.072672, DCA rung TP 0.074 (flat 1%).
    // Price hi 0.073109 must trigger tp_touch at 0.072672 (structural target).
    expect(effectiveTp("long", 0.074, 0.072672)).toBe(0.072672);
  });

  it("long: keeps lot.tp when it is nearer than tp_level", () => {
    expect(effectiveTp("long", 100.5, 101.0)).toBe(100.5);
  });

  it("short: uses tp_level when it is nearer (higher) than lot.tp", () => {
    expect(effectiveTp("short", 99.0, 99.5)).toBe(99.5);
  });

  it("short: keeps lot.tp when it is nearer than tp_level", () => {
    expect(effectiveTp("short", 100.0, 99.5)).toBe(100.0);
  });

  it("falls back to lot.tp when tp_level is null / undefined / 0 / NaN", () => {
    expect(effectiveTp("long", 100, null)).toBe(100);
    expect(effectiveTp("long", 100, undefined)).toBe(100);
    expect(effectiveTp("long", 100, 0)).toBe(100);
    expect(effectiveTp("long", 100, Number.NaN)).toBe(100);
  });

  it("DOGE regression: hi 0.073109 crosses effective 0.072672", () => {
    const eff = effectiveTp("long", 0.074, 0.072672);
    const hi = 0.073109;
    expect(hi >= eff).toBe(true);
    expect(eff).toBe(0.072672);
  });
});
