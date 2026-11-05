import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Snapshot the primary NAV declarations in AppShell and CommandPalette
 * to guarantee the canonical order: Home, Life Map, Automation, Trade,
 * Exchanges. This catches regressions on any surface that lists routes.
 */
const CANONICAL = ["Home", "Life Map", "Automation", "Trade", "Exchanges"];

function extractLabels(src: string, startNeedle: string): string[] {
  const start = src.indexOf(startNeedle);
  if (start < 0) throw new Error(`Missing needle: ${startNeedle}`);
  const chunk = src.slice(start, src.indexOf("] as const", start));
  return Array.from(chunk.matchAll(/label:\s*"([^"]+)"/g)).map((m) => m[1]);
}

describe("primary nav order", () => {
  it("AppShell NAV: Home → Life Map → Automation → Trade → Exchanges", () => {
    const src = readFileSync(resolve("src/components/shell/AppShell.tsx"), "utf8");
    expect(extractLabels(src, "const NAV = [")).toEqual(CANONICAL);
  });

  it("CommandPalette top 5 routed items match canonical order", () => {
    const src = readFileSync(resolve("src/components/shell/CommandPalette.tsx"), "utf8");
    const labels = Array.from(src.matchAll(/label:\s*"([^"]+)"/g)).map((m) => m[1]);
    expect(labels.slice(0, 5)).toEqual(CANONICAL);
  });

  it("FloatingCommandDock ITEMS match canonical order", () => {
    const src = readFileSync(resolve("src/components/command/FloatingCommandDock.tsx"), "utf8");
    expect(extractLabels(src, "const ITEMS = [")).toEqual(CANONICAL);
  });

  it("keeps a global back control on every authenticated page except Home", () => {
    const src = readFileSync(resolve("src/components/shell/AppShell.tsx"), "utf8");
    expect(src).toContain('pathname !== "/home"');
    expect(src).toContain("<BackButton");
    expect(src).toContain("z-[70]");
  });

  it("keeps separate phone and desktop Home layouts", () => {
    const shell = readFileSync(resolve("src/components/shell/AppShell.tsx"), "utf8");
    const home = readFileSync(resolve("src/routes/_authenticated/home.tsx"), "utf8");
    const dashboard = readFileSync(
      resolve("src/components/home/MobileTradingDashboard.tsx"),
      "utf8",
    );

    expect(shell).toContain('const phoneDashboard = pathname === "/home"');
    expect(shell).toContain('phoneDashboard ? "max-w-[430px] md:max-w-none lg:max-w-[1760px]"');
    expect(shell).not.toContain("IntelStreamCluster");
    expect(shell).toContain("Ask Onyx");
    expect(shell).toContain("openScout()");
    expect(home).toContain('className="lg:hidden"');
    expect(home).toContain('className="hidden lg:block"');
    expect(dashboard).toContain("max-w-[430px]");
    expect(dashboard).toContain('to="/scout" label="Scout"');
  });
});
