import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PENDING_DECISION_TABLES, pendingSchema } from "@/lib/decision/pendingTables";

/**
 * `src/integrations/supabase/types.ts` is GENERATED from the live Supabase
 * schema, which Lovable owns. `strategy_decisions` and `ai_decision_opinions`
 * are proposed in `docs/supabase-proposals/001_*` and reached through the
 * `pendingSchema()` seam until Lovable applies them.
 *
 * WHAT THESE TESTS DELIBERATELY DO NOT DO
 * ---------------------------------------
 * An earlier version asserted the two tables were ABSENT from the generated
 * types, framed as "nobody hand-edited the generated file". That framing was
 * wrong: absence cannot tell a hand-edit apart from a legitimate
 * regeneration, so the assertion would have gone red the moment Lovable did
 * exactly what it was asked to do — turning a successful migration into a
 * failing build for no reason. There is no honest content-level test for "was
 * this file hand-edited", so none is attempted here.
 *
 * What IS worth holding is below, and holds in BOTH states — before the
 * proposal is applied and after.
 */
const GENERATED = readFileSync("src/integrations/supabase/types.ts", "utf8");
const PROPOSAL = readFileSync(
  "docs/supabase-proposals/001_strategy_decisions.proposed.sql",
  "utf8",
);

/**
 * A table DEFINITION in the generated file — not a `referencedRelation`
 * mention from some unrelated foreign key.
 */
const isGenerated = (table: string) =>
  new RegExp(`^\\s{6}${table}: \\{`, "m").test(GENERATED);

describe("pending decision tables", () => {
  it("name exactly the tables the proposal creates", () => {
    const created = [
      ...PROPOSAL.matchAll(/CREATE TABLE[^;(]*?public\.(\w+)/gi),
    ].map((m) => m[1]);
    // The seam must not claim a table the migration does not create, nor miss
    // one it does. Either mismatch sends a reader looking for a bug that is
    // not there.
    expect([...PENDING_DECISION_TABLES].sort()).toEqual(
      [...new Set(created)].sort(),
    );
  });

  it("arrive together or not at all", () => {
    // A half-applied schema IS worth failing on: the flow panel would render
    // decisions with the AI column permanently blank and no error anywhere,
    // which reads as "the committee said nothing" rather than "that table
    // does not exist yet".
    const present = PENDING_DECISION_TABLES.filter(isGenerated);
    expect(
      present.length === 0 || present.length === PENDING_DECISION_TABLES.length,
    ).toBe(true);
  });

  it("survive the transition in either state", () => {
    // Pre-apply the seam is load-bearing. Post-apply it is redundant but
    // harmless — `pendingSchema` is an identity cast, so leaving it in place
    // cannot break anything. Retiring it is cleanup, not a fix, and is NOT
    // forced by a failing test here.
    //
    // TO RETIRE, once both tables are in the generated types: replace
    // `pendingSchema(client)` with `client` at its call sites, then delete
    // `src/lib/decision/pendingTables.ts` and this file.
    expect(typeof pendingSchema).toBe("function");
    const client = { from: () => null };
    expect(pendingSchema(client as never)).toBe(client);
  });

  it("is a narrow seam, not a general escape hatch", () => {
    const src = readFileSync("src/lib/decision/pendingTables.ts", "utf8");
    expect(PENDING_DECISION_TABLES).toHaveLength(2);
    // It must not grow into a generic "any table" helper.
    expect(src).not.toMatch(/export function\s+\w+<[^>]*>/);
  });
});
