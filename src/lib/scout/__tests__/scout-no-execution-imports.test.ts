/**
 * Static import boundary — Scout code MUST NOT reach any execution / order /
 * wallet mutation surface. This test greps every file under src/lib/scout and
 * src/components/scout for banned import paths.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["src/lib/scout", "src/components/scout", "src/hooks/useScoutActivation.ts", "src/hooks/useScoutIntelligence.ts"];

// The ban targets EXECUTION / ORDER / WALLET MUTATION surfaces. It is NOT
// a ban on the admin Supabase client in general: Scout's server functions
// legitimately load `@/integrations/supabase/client.server` inside handlers
// to invoke SECURITY DEFINER RPCs for read/persistence work that Scout is
// authorised to perform (e.g. `scout_persist_scan`, `has_role`). Those RPCs
// are governance-approved and touch no execution surface. Adding
// `client.server` back to this list would weaken the real intent (blocking
// execution paths) without adding safety — the execution surfaces below
// are what actually mutate orders/wallets, and those remain fully banned.
const BANNED_SUBSTRINGS = [
  "@/lib/paper/engine",
  "@/lib/paper/operations",
  "@/lib/paper/repository",
  "@/lib/paper/ladder",
  "@/lib/paper/accumulator-dca",
  "@/lib/onyx/decide",
  "supabase/functions/execution-broker",
  "supabase/functions/apex-",
  "supabase/functions/worker-ingest",
  "signer/",
];

function walk(path: string, acc: string[] = []): string[] {
  let st;
  try { st = statSync(path); } catch { return acc; }
  if (st.isFile()) {
    if (path.endsWith(".ts") || path.endsWith(".tsx")) acc.push(path);
    return acc;
  }
  for (const name of readdirSync(path)) {
    if (name === "__tests__") continue;
    walk(join(path, name), acc);
  }
  return acc;
}

describe("scout: no execution imports", () => {
  const files = ROOTS.flatMap((r) => walk(r));
  it("has files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const f of files) {
    it(`${f} has no banned imports`, () => {
      const src = readFileSync(f, "utf8");
      for (const banned of BANNED_SUBSTRINGS) {
        expect(src.includes(banned), `banned import "${banned}" in ${f}`).toBe(false);
      }
    });
  }
});
