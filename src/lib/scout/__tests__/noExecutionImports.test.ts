/**
 * Architectural guard: `src/lib/scout/**` must NEVER import execution code.
 * Scout is read-only. Any drift toward pulling in engine / repository /
 * execution-broker / order intents is a hard failure.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SCOUT_ROOT = resolve(__dirname, "..");

// Paths that would represent execution / mutation surfaces. If any Scout
// module imports from one of these substrings, the guard fails.
const FORBIDDEN_IMPORTS = [
  "@/lib/paper/engine",
  "@/lib/paper/repository",
  "@/lib/paper/operations",
  "@/lib/execution",
  "execution-broker",
  "order_intents",
  "order-intents",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === "__tests__") continue; // this guard itself lives here
      walk(p, out);
    } else if (p.endsWith(".ts") || p.endsWith(".tsx")) {
      out.push(p);
    }
  }
  return out;
}

describe("scout read-only architectural guard", () => {
  it("no Scout module imports execution / mutation surfaces", () => {
    const files = walk(SCOUT_ROOT);
    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf-8");
      for (const needle of FORBIDDEN_IMPORTS) {
        // Only match on lines that look like imports/re-exports so a stray
        // string literal in a comment doesn't false-positive.
        const importPattern = new RegExp(
          `^(?:import|export)[^\\n]*['\"][^'\"]*${needle.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}[^'\"]*['\"]`,
          "m",
        );
        if (importPattern.test(src)) {
          violations.push(`${file}: imports \`${needle}\``);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
