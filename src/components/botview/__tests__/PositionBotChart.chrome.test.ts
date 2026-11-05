/**
 * Chart chrome guards — owner directives:
 *  - default trailing window is wide (~1-2h), not the previous tight ~8m
 *  - price/time gridlines rendered in the Onixus hot-blue token
 *  - overlays (target/entry ReferenceLine) remain wired
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../PositionBotChart.tsx"),
  "utf8",
);

describe("PositionBotChart chrome", () => {
  it("uses a wide default window (60–180 min)", () => {
    const m = SRC.match(/WINDOW_MINUTES\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    const mins = Number(m![1]);
    expect(mins).toBeGreaterThanOrEqual(60);
    expect(mins).toBeLessThanOrEqual(180);
  });

  it("renders a CartesianGrid coloured by the Onixus hot-blue token", () => {
    expect(SRC).toMatch(/import\s*\{[^}]*CartesianGrid[^}]*\}\s*from\s*"recharts"/);
    expect(SRC).toMatch(/<CartesianGrid[\s\S]*?stroke=\{GRID_BLUE\}/);
    expect(SRC).toMatch(/GRID_BLUE\s*=\s*"var\(--onixus-hot-blue/);
  });

  it("keeps entry and target overlays wired", () => {
    expect(SRC).toMatch(/ReferenceLine/);
  });
});
