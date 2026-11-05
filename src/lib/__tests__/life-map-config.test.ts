import { describe, it, expect } from "vitest";
import {
  normalizeTargetBudgetItemsToObligations,
  CANONICAL_LIFE_CATEGORIES,
} from "../life-map-config";

describe("normalizeTargetBudgetItemsToObligations", () => {
  it("returns [] for empty object", () => {
    expect(normalizeTargetBudgetItemsToObligations({})).toEqual([]);
  });

  it("returns [] for null/undefined/non-object input", () => {
    expect(normalizeTargetBudgetItemsToObligations(null)).toEqual([]);
    expect(normalizeTargetBudgetItemsToObligations(undefined)).toEqual([]);
    expect(normalizeTargetBudgetItemsToObligations("nope")).toEqual([]);
    expect(normalizeTargetBudgetItemsToObligations(42)).toEqual([]);
  });

  it("normalizes a populated blob into obligation rows", () => {
    const blob = {
      roof: {
        target: 2000,
        current: 0,
        active_strategy: null,
        items: [
          { id: "rent", icon: "home", label: "Rent", amount: 1200 },
          { id: "water", icon: "droplet", label: "Water Bill", amount: 65 },
        ],
      },
      ride: {
        target: 400,
        current: 0,
        active_strategy: null,
        items: [{ id: "payment", icon: "car", label: "Car Payment", amount: 350 }],
      },
      memories: { target: 0, current: 0, active_strategy: null, items: [] },
      escape: { target: 0, current: 0, active_strategy: null, items: [] },
    };
    const rows = normalizeTargetBudgetItemsToObligations(blob);
    expect(rows).toEqual([
      { category_key: "roof", name: "Rent",        amount: 1200, currency: "USD", kind: "bill", is_essential: true,  legacy_item_id: "rent" },
      { category_key: "roof", name: "Water Bill",  amount: 65,   currency: "USD", kind: "bill", is_essential: true,  legacy_item_id: "water" },
      { category_key: "ride", name: "Car Payment", amount: 350,  currency: "USD", kind: "bill", is_essential: true,  legacy_item_id: "payment" },
    ]);
  });

  it("is idempotent at the logic level (running twice yields identical output)", () => {
    const blob = {
      roof: { target: 100, current: 0, active_strategy: null, items: [{ id: "rent", icon: "home", label: "Rent", amount: 1200 }] },
      memories: { target: 0, current: 0, active_strategy: null, items: [{ id: "wed", icon: "heart", label: "Wedding", amount: 5000 }] },
    };
    const a = normalizeTargetBudgetItemsToObligations(blob);
    const b = normalizeTargetBudgetItemsToObligations(blob);
    expect(b).toEqual(a);
    // Deterministic order: roof before memories.
    expect(a.map((r) => r.category_key)).toEqual(["roof", "memories"]);
  });

  it("ignores unknown/malformed buckets and items", () => {
    const blob = {
      alien: { target: 999, current: 0, active_strategy: null, items: [{ id: "x", label: "X", amount: 1 }] },
      roof: {
        target: 0,
        current: 0,
        active_strategy: null,
        items: [
          null,
          "string",
          { label: "No id here", amount: 10 }, // missing id -> skipped
          { id: "ok", icon: "home", label: "Rent", amount: "1200" }, // string amount coerced
          { id: "nan", icon: "home", label: "Bad", amount: "not-a-number" }, // NaN -> 0
        ],
      },
    };
    const rows = normalizeTargetBudgetItemsToObligations(blob);
    expect(rows).toEqual([
      { category_key: "roof", name: "Rent", amount: 1200, currency: "USD", kind: "bill", is_essential: true, legacy_item_id: "ok" },
      { category_key: "roof", name: "Bad",  amount: 0,    currency: "USD", kind: "bill", is_essential: true, legacy_item_id: "nan" },
    ]);
  });

  it("marks essential vs. non-essential per bucket", () => {
    const blob = {
      roof:     { items: [{ id: "a", label: "A", amount: 1 }] },
      ride:     { items: [{ id: "b", label: "B", amount: 1 }] },
      memories: { items: [{ id: "c", label: "C", amount: 1 }] },
      escape:   { items: [{ id: "d", label: "D", amount: 1 }] },
    };
    const rows = normalizeTargetBudgetItemsToObligations(blob);
    expect(rows.find((r) => r.legacy_item_id === "a")?.is_essential).toBe(true);
    expect(rows.find((r) => r.legacy_item_id === "b")?.is_essential).toBe(true);
    expect(rows.find((r) => r.legacy_item_id === "c")?.is_essential).toBe(false);
    expect(rows.find((r) => r.legacy_item_id === "d")?.is_essential).toBe(false);
  });
});

describe("CANONICAL_LIFE_CATEGORIES", () => {
  it("has exactly the 8 canonical keys with expected essentiality", () => {
    expect(CANONICAL_LIFE_CATEGORIES.map((c) => c.key)).toEqual([
      "roof", "ride", "memories", "escape", "body", "family", "debt", "future",
    ]);
    const essential = new Set(
      CANONICAL_LIFE_CATEGORIES.filter((c) => c.is_essential).map((c) => c.key),
    );
    expect(essential).toEqual(new Set(["roof", "ride", "body", "debt"]));
  });
});
