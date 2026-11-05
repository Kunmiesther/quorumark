import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression tests proving the blanket CROSS-only lock (commit 71d3bb4)
 * is fully superseded by the venue capability registry.
 *
 * These are static/source-level checks so they run without a live DB.
 * DB-level state is verified by the migration itself; see report.
 */

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
function readAllMigrations(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
    .join("\n");
}

function readAllSource(dir: string): string {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(readAllSource(p));
    else if (/\.(ts|tsx)$/.test(ent.name) && !p.includes("__tests__"))
      out.push(readFileSync(p, "utf8"));
  }
  return out.join("\n");
}

describe("corrective audit — blanket cross-only fully superseded", () => {
  const migrations = readAllMigrations();

  it("supersede audit event was emitted for every prior lock event", () => {
    expect(migrations).toContain("CROSS_MARGIN_POLICY_SUPERSEDED_BY_VENUE_REGISTRY");
    expect(migrations).toContain("supersedes_event_id");
  });

  it("reconciliation flag column exists on paper_positions and user_strategy", () => {
    expect(migrations).toMatch(
      /ALTER TABLE public\.paper_positions[\s\S]*capability_reconciliation_required/,
    );
    expect(migrations).toMatch(
      /ALTER TABLE public\.user_strategy[\s\S]*capability_reconciliation_required/,
    );
  });

  it("prior lock audit rows are preserved (not deleted)", () => {
    expect(migrations).not.toMatch(/DELETE\s+FROM\s+public\.margin_policy_events/i);
  });

  it("no executable global MARGIN_MODE='cross' assumption remains outside the venue registry", () => {
    const src = readAllSource(join(process.cwd(), "src"));
    // The banned symbols from the reverted policy module.
    expect(src).not.toMatch(/\bassertCrossMargin\s*\(/);
    expect(src).not.toMatch(/\bstampCrossOnOnyxDecision\s*\(/);
    expect(src).not.toMatch(/@\/lib\/margin\/policy/);
    // Reason code CROSS_MARGIN_REQUIRED must not be re-introduced as an
    // application-level fail-closed code (venue registry uses its own codes).
    expect(src).not.toMatch(/["']CROSS_MARGIN_REQUIRED["']/);
  });

  it("venue capability registry declares ApeX as cross-only (unchanged) and BYDFi/BTCC as multi-mode", async () => {
    const { listStaticCapabilities } = await import("../registry");
    const caps = listStaticCapabilities();
    const apex = caps.find((c) => c.key.exchange === "apex_omni");
    const bydfi = caps.find((c) => c.key.exchange === "bydfi");
    const btcc = caps.find((c) => c.key.exchange === "btcc");
    expect(apex?.capabilities.allowed_margin_modes).toEqual(["cross"]);
    expect(bydfi?.capabilities.allowed_margin_modes.sort()).toEqual(["cross", "isolated"]);
    expect(btcc?.capabilities.allowed_margin_modes.sort()).toEqual(["cross", "isolated"]);
  });
});
