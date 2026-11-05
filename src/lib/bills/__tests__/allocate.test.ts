import { describe, it, expect } from "vitest";
import { allocate, periodKeyFor, type BillForAlloc } from "../allocate";

const B = (id: string, amount: number, priority: number, created = "2026-01-01T00:00:00Z"): BillForAlloc => ({
  id, amount_usd: amount, priority, created_at: created,
});

describe("allocate — bills v2", () => {
  it("no-op on zero delta", () => {
    const r = allocate({ bills: [B("a", 100, 1)], covered: {}, delta_usd: 0 });
    expect(r.ops).toEqual([]);
    expect(r.unallocated_usd).toBe(0);
    expect(r.unabsorbed_usd).toBe(0);
  });

  it("no-op when no bills", () => {
    const r = allocate({ bills: [], covered: {}, delta_usd: 10 });
    expect(r.ops).toEqual([]);
    expect(r.unallocated_usd).toBe(10);
  });

  it("fills bills in priority order (lower priority first)", () => {
    const bills = [B("rent", 1500, 1), B("phone", 100, 5), B("gym", 50, 10)];
    const r = allocate({ bills, covered: {}, delta_usd: 1600 });
    expect(r.ops).toEqual([
      { bill_id: "rent", delta_usd: 1500 },
      { bill_id: "phone", delta_usd: 100 },
    ]);
    expect(r.unallocated_usd).toBe(0);
  });

  it("partial fill stops at delta", () => {
    const bills = [B("rent", 1500, 1), B("phone", 100, 5)];
    const r = allocate({ bills, covered: { rent: 200 }, delta_usd: 300 });
    expect(r.ops).toEqual([{ bill_id: "rent", delta_usd: 300 }]);
  });

  it("spills to next bill when current is at cap", () => {
    const bills = [B("rent", 1500, 1), B("phone", 100, 5)];
    const r = allocate({ bills, covered: { rent: 1500 }, delta_usd: 60 });
    expect(r.ops).toEqual([{ bill_id: "phone", delta_usd: 60 }]);
  });

  it("returns unallocated when all bills full", () => {
    const bills = [B("a", 10, 1), B("b", 20, 2)];
    const r = allocate({ bills, covered: { a: 10, b: 20 }, delta_usd: 50 });
    expect(r.ops).toEqual([]);
    expect(r.unallocated_usd).toBe(50);
  });

  it("negative delta drains in REVERSE priority order (least priority first)", () => {
    const bills = [B("rent", 1500, 1), B("phone", 100, 5), B("gym", 50, 10)];
    const covered = { rent: 500, phone: 100, gym: 50 };
    const r = allocate({ bills, covered, delta_usd: -120 });
    // gym (10) drains first: 50, then phone (5) drains 70
    expect(r.ops).toEqual([
      { bill_id: "gym", delta_usd: -50 },
      { bill_id: "phone", delta_usd: -70 },
    ]);
    expect(r.unabsorbed_usd).toBe(0);
  });

  it("HONESTY: losses visibly reduce coverage — filled bill can drop", () => {
    const bills = [B("rent", 1500, 1)];
    const covered = { rent: 800 };
    const r = allocate({ bills, covered, delta_usd: -300 });
    expect(r.ops).toEqual([{ bill_id: "rent", delta_usd: -300 }]);
    // The caller applies this to reach 500 — verify the sign is negative.
    expect(r.ops[0].delta_usd).toBeLessThan(0);
  });

  it("negative drain never takes a bill below zero", () => {
    const bills = [B("a", 100, 1)];
    const r = allocate({ bills, covered: { a: 30 }, delta_usd: -80 });
    expect(r.ops).toEqual([{ bill_id: "a", delta_usd: -30 }]);
    expect(r.unabsorbed_usd).toBe(-50);
  });

  it("determinism: same inputs produce same outputs (idempotency helper)", () => {
    const bills = [B("a", 100, 1), B("b", 50, 2)];
    const covered = { a: 10 };
    const r1 = allocate({ bills, covered, delta_usd: 75 });
    const r2 = allocate({ bills, covered, delta_usd: 75 });
    expect(r1).toEqual(r2);
  });

  it("ties on priority broken by created_at then id", () => {
    const bills = [
      B("z", 50, 1, "2026-02-01T00:00:00Z"),
      B("a", 50, 1, "2026-01-01T00:00:00Z"),
    ];
    const r = allocate({ bills, covered: {}, delta_usd: 60 });
    // "a" is older → fills first
    expect(r.ops[0].bill_id).toBe("a");
    expect(r.ops[1].bill_id).toBe("z");
  });

  it("periodKeyFor returns UTC YYYY-MM", () => {
    expect(periodKeyFor("2026-07-15T23:59:00Z")).toBe("2026-07");
    expect(periodKeyFor("2026-01-01T00:00:00Z")).toBe("2026-01");
  });
});
