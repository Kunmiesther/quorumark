/**
 * SCOUT STAGE 2 FEATURE FLAG.
 *
 * The Stage 2 wiring (scout_persist_scan RPC + market context + outcome
 * evaluator) shipped, but the required two-user RLS integration test
 * could not be executed by the automated harness (no ability to mint
 * distinct authenticated sessions in this environment). Until that
 * verification can run and pass, Stage 2 evidence PERSISTENCE stays
 * behind a server-only opt-in.
 *
 * Semantics:
 *   SCOUT_STAGE2_PERSIST_ENABLED = "1" or "true" (server env only) → wire
 *     evidence into the persistence RPC.
 *   anything else (default) → skip persistence; Scout market display and
 *     pure evaluation continue to work.
 *
 * Read this ONLY inside a server function handler (never at module scope).
 */
export function scoutStage2PersistEnabled(): boolean {
  // process.env is server-only. On the client this returns false, which is
  // the correct fail-closed default — the client never calls the RPC.
  if (typeof process === "undefined" || !process.env) return false;
  const raw = process.env.SCOUT_STAGE2_PERSIST_ENABLED;
  if (raw == null) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
