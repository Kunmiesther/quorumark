import { describe, it, expect } from "vitest";
import { BOTTOM_NAV_ITEMS } from "../BottomNav";

const EXPECTED = [
  { label: "Home", to: "/home" },
  { label: "Life Map", to: "/life-map" },
  { label: "Automation", to: "/automation" },
  { label: "Trade", to: "/trade" },
  { label: "Exchanges", to: "/exchanges" },
];

describe("BottomNav", () => {
  it("exposes exactly 5 tabs", () => {
    expect(BOTTOM_NAV_ITEMS).toHaveLength(5);
  });
  it("matches canonical order: Home, Life Map, Automation, Trade, Exchanges", () => {
    expect(BOTTOM_NAV_ITEMS.map((i) => i.label)).toEqual(EXPECTED.map((e) => e.label));
    expect(BOTTOM_NAV_ITEMS.map((i) => i.to)).toEqual(EXPECTED.map((e) => e.to));
  });
});
