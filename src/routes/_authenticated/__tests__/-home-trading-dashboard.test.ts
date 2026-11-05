import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HOME = readFileSync(resolve("src/routes/_authenticated/home.tsx"), "utf8");

describe("desktop Home trading dashboard", () => {
  it("replaces promotional discovery cards with live command actions", () => {
    expect(HOME).toContain("<HomeCommandDeck");
    expect(HOME).toContain('to="/trade"');
    expect(HOME).toContain('to="/scout"');
    expect(HOME).toContain('to="/automation"');
    expect(HOME).not.toContain("<DiscoveryTiles");
    expect(HOME).not.toContain("Hot &amp; Trending");
  });

  it("keeps exposure ahead of the compact moving market rail", () => {
    const positions = HOME.indexOf('title="Positions"');
    const holdings = HOME.indexOf('title="Holdings"');
    const market = HOME.indexOf("<MarketFeedSection desktop");
    expect(positions).toBeGreaterThan(-1);
    expect(holdings).toBeGreaterThan(-1);
    expect(market).toBeGreaterThan(positions);
    expect(market).toBeGreaterThan(holdings);
    expect(HOME).toContain("tb-market-marquee-track");
  });
});
