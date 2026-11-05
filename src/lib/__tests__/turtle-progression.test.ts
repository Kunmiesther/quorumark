import { describe, it, expect } from "vitest";
import {
  OFFICIAL_TURTLES,
  levelForPoints,
  pointsToNextLevel,
  isEssentialFeatureLocked,
  eventToMilestone,
  idempotencyKey,
  idempotencyKeyOncePerUser,
  idempotencyKeyOncePerUserCategory,
  idempotencyKeySeriesPeriod,
  resolveAwards,
  POINTS_HAVE_NO_CASH_VALUE,
  POINTS_PER_LEVEL,
  MILESTONE_SCOPE,
} from "../turtle-progression";

describe("levelForPoints / pointsToNextLevel", () => {
  it("thresholds", () => {
    expect(levelForPoints(0)).toBe(1);
    expect(levelForPoints(99)).toBe(1);
    expect(levelForPoints(100)).toBe(2);
    expect(levelForPoints(250)).toBe(3);
  });
  it("negatives / NaN clamp to 1", () => {
    expect(levelForPoints(-1)).toBe(1);
    expect(levelForPoints(NaN)).toBe(1);
    expect(levelForPoints(Infinity)).toBe(1);
  });
  it("pointsToNextLevel consistent with levelForPoints", () => {
    for (const p of [0, 25, 99, 100, 101, 250, 999]) {
      const next = p + pointsToNextLevel(p);
      expect(next % POINTS_PER_LEVEL).toBe(0);
      expect(levelForPoints(next)).toBe(levelForPoints(p) + 1);
    }
    expect(pointsToNextLevel(-5)).toBe(POINTS_PER_LEVEL);
    expect(pointsToNextLevel(NaN)).toBe(POINTS_PER_LEVEL);
  });
});

describe("OFFICIAL_TURTLES", () => {
  it("has exactly the 6 official turtles with the canonical suit names", () => {
    expect(OFFICIAL_TURTLES).toEqual([
      { slug: "dca", suit: "The Accumulator" },
      { slug: "break-retest", suit: "The Vanguard" },
      { slug: "rsi-divergence", suit: "The Sniper" },
      { slug: "ema-cross", suit: "The Scout" },
      { slug: "liq-hunting", suit: "The Hunter" },
      { slug: "funding-arb", suit: "The Arbiter" },
    ]);
    const allowed = new Set([
      "The Vanguard",
      "The Accumulator",
      "The Sniper",
      "The Scout",
      "The Hunter",
      "The Arbiter",
    ]);
    for (const t of OFFICIAL_TURTLES) expect(allowed.has(t.suit)).toBe(true);
    expect(OFFICIAL_TURTLES.length).toBe(6);
  });
});

describe("isEssentialFeatureLocked", () => {
  it("always false regardless of tier / points / level", () => {
    for (const tier of ["free", "pro", "elite", "", undefined]) {
      for (const points of [0, 50, 100, 100000]) {
        for (const level of [1, 5, 99]) {
          expect(isEssentialFeatureLocked(tier as string | undefined, points, level)).toBe(false);
        }
      }
    }
  });
});

describe("eventToMilestone (anti-farming)", () => {
  it("'created' no longer maps to a repeatable award", () => {
    expect(eventToMilestone("created")).toBeNull();
  });
  it("'funded' still maps to obligation_funded", () => {
    expect(eventToMilestone("funded")).toBe("obligation_funded");
  });
  it("other events return null", () => {
    for (const e of ["paid", "updated", "deleted", "overdue", "nope"]) {
      expect(eventToMilestone(e)).toBeNull();
    }
  });
});

describe("MILESTONE_SCOPE catalog", () => {
  it("scopes are correct", () => {
    expect(MILESTONE_SCOPE.first_obligation).toBe("once_per_user");
    expect(MILESTONE_SCOPE.first_category_setup).toBe("once_per_user_category");
    expect(MILESTONE_SCOPE.obligation_paid_on_time).toBe("series_period");
    expect(MILESTONE_SCOPE.obligation_funded).toBe("series_period");
    expect(MILESTONE_SCOPE.overdue_cleared).toBe("series_period");
  });
});

describe("idempotency keys", () => {
  it("once_per_user has no period component", () => {
    expect(idempotencyKeyOncePerUser("u1", "first_obligation")).toBe("u1:first_obligation");
  });
  it("once_per_user_category includes category id", () => {
    expect(idempotencyKeyOncePerUserCategory("u1", "first_category_setup", "cat1")).toBe(
      "u1:first_category_setup:cat1",
    );
  });
  it("series_period includes series + period + code", () => {
    const k = idempotencyKeySeriesPeriod("u1", "s1", "2026-07", "obligation_paid_on_time");
    expect(k).toBe("u1:s1:2026-07:obligation_paid_on_time");
  });
  it("paid -> unpaid -> paid within same period yields SAME key (DO NOTHING blocks re-award)", () => {
    const a = idempotencyKeySeriesPeriod("u1", "s1", "2026-07", "obligation_paid_on_time");
    const b = idempotencyKeySeriesPeriod("u1", "s1", "2026-07", "obligation_paid_on_time");
    expect(a).toBe(b);
  });
  it("different period -> different key", () => {
    expect(idempotencyKeySeriesPeriod("u1", "s1", "2026-07", "obligation_paid_on_time")).not.toBe(
      idempotencyKeySeriesPeriod("u1", "s1", "2026-08", "obligation_paid_on_time"),
    );
  });
  it("legacy idempotencyKey helper still stable", () => {
    expect(idempotencyKey("u1", "obligation_paid_on_time", "o1", "2026-07")).toBe(
      "u1:obligation_paid_on_time:o1:2026-07",
    );
  });
});

describe("resolveAwards — anti-farming eligibility", () => {
  const base = {
    seriesId: "s1",
    billingPeriod: "2026-07",
    nowYyyyMm: "2026-07",
    amount: 100,
    monthlyTarget: 0,
    categoryKey: "family",
  };

  it("archived obligation earns nothing", () => {
    expect(resolveAwards({ ...base, event: "created", archived: true })).toEqual([]);
  });

  it("amount=0 and monthlyTarget=0 earns nothing", () => {
    expect(resolveAwards({ ...base, event: "created", amount: 0, monthlyTarget: 0 })).toEqual([]);
  });

  it("created (family) -> first_obligation + first_category_setup", () => {
    expect(resolveAwards({ ...base, event: "created" })).toEqual([
      "first_obligation",
      "first_category_setup",
    ]);
  });

  it("created for 'roof' adds first_roof_setup", () => {
    expect(resolveAwards({ ...base, event: "created", categoryKey: "roof" })).toEqual([
      "first_obligation",
      "first_category_setup",
      "first_roof_setup",
    ]);
  });

  it("created for 'ride' adds first_ride_setup", () => {
    expect(resolveAwards({ ...base, event: "created", categoryKey: "ride" })).toEqual([
      "first_obligation",
      "first_category_setup",
      "first_ride_setup",
    ]);
  });

  it("funded with oldStatus='funded' does NOT re-award", () => {
    expect(
      resolveAwards({ ...base, event: "funded", oldStatus: "funded", newStatus: "funded" }),
    ).toEqual([]);
  });

  it("funded with real transition awards obligation_funded", () => {
    expect(
      resolveAwards({ ...base, event: "funded", oldStatus: "upcoming", newStatus: "funded" }),
    ).toEqual(["obligation_funded"]);
  });

  it("paid from overdue -> only overdue_cleared, never obligation_paid_on_time", () => {
    const r = resolveAwards({
      ...base,
      event: "paid",
      oldStatus: "overdue",
      newStatus: "paid",
      dueDate: "2026-07-15",
      paidAt: "2026-07-14",
    });
    expect(r).toEqual(["overdue_cleared"]);
  });

  it("paid on time (paidAt <= dueDate) awards obligation_paid_on_time", () => {
    expect(
      resolveAwards({
        ...base,
        event: "paid",
        oldStatus: "upcoming",
        newStatus: "paid",
        dueDate: "2026-07-15",
        paidAt: "2026-07-10T09:00:00Z",
      }),
    ).toEqual(["obligation_paid_on_time"]);
  });

  it("paid late (paidAt > dueDate) earns nothing", () => {
    expect(
      resolveAwards({
        ...base,
        event: "paid",
        oldStatus: "upcoming",
        newStatus: "paid",
        dueDate: "2026-07-15",
        paidAt: "2026-07-16T09:00:00Z",
      }),
    ).toEqual([]);
  });

  it("paid with FUTURE billing period earns nothing (no early-payment farming)", () => {
    expect(
      resolveAwards({
        ...base,
        event: "paid",
        oldStatus: "upcoming",
        newStatus: "paid",
        billingPeriod: "2026-12",
        nowYyyyMm: "2026-07",
        dueDate: "2026-12-15",
        paidAt: "2026-07-10T09:00:00Z",
      }),
    ).toEqual([]);
  });

  it("paid without series_id or billing_period earns nothing", () => {
    expect(
      resolveAwards({
        ...base,
        event: "paid",
        seriesId: null,
        oldStatus: "upcoming",
        newStatus: "paid",
        dueDate: "2026-07-15",
        paidAt: "2026-07-10T09:00:00Z",
      }),
    ).toEqual([]);
  });
});

describe("invariants", () => {
  it("POINTS_HAVE_NO_CASH_VALUE is true", () => {
    expect(POINTS_HAVE_NO_CASH_VALUE).toBe(true);
  });
});

describe.skip("Points DB behavior (isolated branch required)", () => {
  it("authenticated cannot INSERT into point_awards", () => {});
  it("authenticated cannot UPDATE or DELETE point_awards", () => {});
  it("per-category monthly ceiling blocks the 201st point", () => {});
  it("series_id immutable trigger raises on UPDATE attempting to change it", () => {});
  it("archived obligation earns nothing (trigger)", () => {});
  it("delete + recreate on same series does not re-award (series_period idempotency)", () => {});
  it("my_points_total() returns 0 with no session (auth.uid() null)", () => {});
  it("my_points_total() sums awards and adjustments (negative adjustments reduce total)", () => {});
  it("points never alter risk_capital / leverage / order size", () => {});
});
