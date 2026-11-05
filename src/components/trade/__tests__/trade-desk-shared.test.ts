/**
 * Shared desk guard: TradeDesk is book-parameterised (paper|live) and
 * renders every named section of the owner reference layout.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const DESK = fs.readFileSync(path.resolve(__dirname, "../TradeDesk.tsx"), "utf8");

describe("TradeDesk shared implementation", () => {
  it("is parameterised by book (paper | live)", () => {
    expect(DESK).toMatch(/book:\s*"paper"\s*\|\s*"live"/);
  });

  it("renders the reference sections", () => {
    expect(DESK).toMatch(/data-testid="trade-desk"/);
    expect(DESK).toMatch(/data-testid="trade-control-panel"/);
    expect(DESK).toMatch(/data-testid="position-control-panel"/);
    expect(DESK).toMatch(/OrderPanel/);
    expect(DESK).toMatch(/ScoutSignalsCard/);
    expect(DESK).toMatch(/OpenPositionsCard/);
    expect(DESK).toMatch(/LifeMapFundingCard/);
    expect(DESK).toMatch(/StatusBar/);
    expect(DESK).toMatch(/ManualTradeTicket/);
    expect(DESK).not.toMatch(/function DeploySlider/);
  });

  it("uses Onixus palette tokens (purple / teal / hot-blue / faint red)", () => {
    expect(DESK).toMatch(/--onixus-purple/);
    expect(DESK).toMatch(/--onixus-teal/);
    expect(DESK).toMatch(/--onixus-hot-blue/);
    expect(DESK).toMatch(/--onixus-red/);
  });

  it("has one reviewed submission path rather than a duplicate deployment button", () => {
    expect(DESK).not.toMatch(/>\s*Deploy Formation\s*</);
    expect(DESK).toContain("<ManualTradeTicket");
  });
});
