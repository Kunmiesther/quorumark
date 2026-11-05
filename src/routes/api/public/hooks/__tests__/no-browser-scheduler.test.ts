/**
 * Static-analysis guard: no browser-side setInterval / setTimeout may
 * invoke the paper-tick server function. The pg_cron endpoint is the
 * single scheduling authority.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      walk(p, out);
    } else if (/\.(t|j)sx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

describe("no browser paper-tick scheduler", () => {
  it("no client module wires runPaperTickFn into setInterval", () => {
    const roots = ["src/components", "src/hooks", "src/routes"];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of walk(root)) {
        // Only look at browser-reachable files. Server routes/functions are
        // in .functions.ts / .server.ts / api/*, not covered here.
        if (/\.server\.ts$/.test(file)) continue;
        if (/\.functions\.tsx?$/.test(file)) continue;
        if (file.includes(`/api/`)) continue;
        const src = readFileSync(file, "utf8");
        if (!src.includes("runPaperTickFn")) continue;
        if (/setInterval|setTimeout/.test(src)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
