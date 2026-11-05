/**
 * Architectural guard: the ops modules must remain pure/read-only and
 * NEVER import execution surfaces (broker, engine, sign, submit).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const OPS_DIR = join(process.cwd(), "src/lib/ops");
// Import-path fragments that MUST NOT appear in an `import ... from "..."` in an ops module.
const FORBIDDEN_IMPORT_FRAGMENTS = [
  "@/lib/paper/engine",
  "@/lib/paper/execution",
  "execution-broker",
  "broker-guard",
  "@/lib/onyx/onyx.functions",
  "@/lib/execution/",
];

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("ops modules stay read-only", () => {
  const files = collectTsFiles(OPS_DIR);

  it("finds ops source files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s imports no execution surface", (file) => {
    const src = readFileSync(file, "utf8");
    // Match every `from "..."` or `import("...")` specifier and check imports only.
    const importRe = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
    const imports: string[] = [];
    for (const m of src.matchAll(importRe)) imports.push(m[1]);
    for (const spec of imports) {
      for (const fragment of FORBIDDEN_IMPORT_FRAGMENTS) {
        expect(spec, `${file} imports forbidden ${fragment}`).not.toContain(fragment);
      }
    }
  });
});
