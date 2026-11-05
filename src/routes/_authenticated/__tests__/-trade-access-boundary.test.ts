import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/routes/_authenticated/trade.tsx", "utf8");

describe("trade route access boundary", () => {
  it("checks canonical access before mounting the shared trade desk", () => {
    const accessCheck = source.indexOf('searchBook === "live" && !access.data.live');
    const deskMount = source.indexOf("<TradeDesk");

    expect(source).toContain("getMyAccess");
    expect(accessCheck).toBeGreaterThan(-1);
    expect(deskMount).toBeGreaterThan(accessCheck);
  });

  it("keeps live unavailable in the mode chooser without an owner grant", () => {
    expect(source).toContain("disabled={!canLive}");
    expect(source).toContain("Restricted to the owner/admin test account.");
  });

  it("does not silently fall back from live to paper", () => {
    expect(source).toContain('<TradeAccessDenied book="live"');
    expect(source).toContain("Open paper trading");
    expect(source).toMatch(/no silent default, no\s+auto-fallback/);
  });
});
