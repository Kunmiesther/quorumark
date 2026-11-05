/**
 * Scout Guardian — paper-engine-side helpers.
 *
 * The Railway worker is the always-on Position Guardian: it evaluates every
 * open position with deterministic rules and enqueues action DIRECTIVES into
 * `scout_guardian_directives`. This module holds the small pure helpers the
 * paper engine uses when it ENFORCES those directives on its next tick. Keeping
 * them here (not inlined in the engine monolith) makes the directive→exit
 * contract unit-testable.
 */

/** Directive types the engine enforces. Mirrors the DB CHECK + the worker. */
export type GuardianDirectiveType = "cancel_unfilled_rungs" | "close_position" | "reduce_position";

/**
 * The two exit reasons a Guardian force-close may write to `paper_trades`.
 * Both are members of the `paper_trades_exit_reason_check` constraint; any
 * other reason_code collapses to the structural default so the engine can
 * never emit a value the CHECK would reject.
 */
export type GuardianExitReason = "scout_guardian_bos" | "scout_guardian_cluster";

export const GUARDIAN_EXIT_REASONS: readonly GuardianExitReason[] = [
  "scout_guardian_bos",
  "scout_guardian_cluster",
];

/**
 * Map a directive `reason_code` to the trade `exit_reason` used when the engine
 * force-closes a position. Only the correlated-cluster rule maps to
 * `scout_guardian_cluster`; every other Guardian close (adverse BOS, ladder
 * escalation, or an unknown/forward-compatible code) is a structural exit.
 */
export function guardianCloseExitReason(reasonCode: string | null | undefined): GuardianExitReason {
  return reasonCode === "scout_guardian_cluster" ? "scout_guardian_cluster" : "scout_guardian_bos";
}
