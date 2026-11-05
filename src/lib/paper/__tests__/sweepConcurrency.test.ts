import { describe, it, expect } from "vitest";
import { evaluateSweepConcurrency } from "../sweepConcurrency";
import { SWEEP_H2_MAX_CONCURRENT_LADDERS } from "../sweepH2";

const mk = (n: number, status: "pending" | "open" = "open") =>
  Array.from({ length: n }, (_, i) => ({
    wallet: `w${i}`, symbol: `SYM${i}`, side: "long" as const, status,
  }));

describe("sweepConcurrency — cross-portfolio cap", () => {
  it("allows a ladder when fewer than cap are active", () => {
    const r = evaluateSweepConcurrency(mk(SWEEP_H2_MAX_CONCURRENT_LADDERS - 1));
    expect(r.allowed).toBe(true);
    expect(r.reason).toBeUndefined();
  });
  it("blocks a 3rd ladder when cap is 2 (H2 spec)", () => {
    expect(SWEEP_H2_MAX_CONCURRENT_LADDERS).toBe(2);
    const r = evaluateSweepConcurrency(mk(2));
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("sweep_concurrency_cap");
    expect(r.currentCount).toBe(2);
    expect(r.cap).toBe(2);
  });
  it("counts pending + open equally (deploying-or-open)", () => {
    const r = evaluateSweepConcurrency([...mk(1, "pending"), ...mk(1, "open")]);
    expect(r.allowed).toBe(false);
  });
  it("releases when a ladder is closed (caller removes it from list)", () => {
    const before = evaluateSweepConcurrency(mk(2));
    expect(before.allowed).toBe(false);
    // After close, caller passes only 1 remaining
    const after = evaluateSweepConcurrency(mk(1));
    expect(after.allowed).toBe(true);
  });
});
