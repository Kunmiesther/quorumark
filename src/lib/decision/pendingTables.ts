/**
 * Compatibility typing for decision tables not yet in generated client types.
 *
 * WHY THIS EXISTS
 * ---------------
 * Both tables have tracked migrations. Production schema drift left the
 * opinions table absent; 20260926182604_restore_ai_decision_opinions repairs
 * that omission. Generated TypeScript and the deployed database can differ:
 * this adapter is not evidence that a table exists or is absent.
 *
 * Hand-editing the generated file to add them would be wrong twice over:
 *   * it makes the repository assert that the database has tables it does not,
 *     which is exactly the kind of claim that sends a reader (human or agent)
 *     looking for a bug that isn't there; and
 *   * the next regeneration silently deletes the additions and the build
 *     breaks, with no clue as to why.
 *
 * So the generated file stays generated, and the two pending tables are
 * reached through this one narrow, named seam instead.
 *
 * IS THIS SAFE?
 * -------------
 * The compile-time table typing is what is relaxed here, not the validation.
 * Every row read from these tables still crosses `parseDecisionRow` /
 * `parseOpinionRow` in `decisionFlow.ts`, which are zod schemas that return
 * `null` on any deviation rather than a partial guess. That runtime check is
 * the real guard and it is unaffected.
 *
 * WHEN TO DELETE THIS FILE
 * ------------------------
 * Once schema verification and regeneration of `types.ts` put both
 * tables appear in `Database`. At that point replace `pendingSchema(client)`
 * with `client` at its call sites and delete this module.
 *
 * Nothing forces that cleanup and nothing breaks without it: `pendingSchema`
 * is an identity cast, so it stays correct after the tables exist. The
 * accompanying test passes in both states on purpose — a successful migration
 * must not present itself as a failing build.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Decision tables covered by this compatibility adapter. */
export const PENDING_DECISION_TABLES = [
  "strategy_decisions",
  "ai_decision_opinions",
] as const;

export type PendingDecisionTable = (typeof PENDING_DECISION_TABLES)[number];

/**
 * The same client, typed to permit the pending tables.
 *
 * Deliberately not generic and deliberately not exported as a general-purpose
 * escape hatch: it exists for the two tables named above and nothing else.
 */
export function pendingSchema(client: unknown): SupabaseClient {
  return client as SupabaseClient;
}
