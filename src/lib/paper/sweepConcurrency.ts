/**
 * H2 sweep-DCA — concurrency cap helper.
 *
 * Cross-portfolio protection: at most SWEEP_H2_MAX_CONCURRENT_LADDERS sweep
 * ladders may be simultaneously deploying (pending first fill) or open
 * (any rung filled and not yet fully closed). Additional sweep signals are
 * skipped and logged with reason "sweep_concurrency_cap".
 *
 * Deliberately schema-agnostic: callers pass in the current ladder inventory
 * so this helper stays pure and unit-testable. Engine wiring provides the
 * inventory from the paper positions repository; the Python worker mirrors
 * this behaviour via sweep_h2_concurrency.py (to be added when worker dispatch
 * is wired).
 */
import { SWEEP_H2_MAX_CONCURRENT_LADDERS } from "./sweepH2";

export interface SweepLadderRef {
  /** Wallet or account id the ladder is scoped to (for logging only). */
  wallet: string;
  symbol: string;
  side: "long" | "short";
  /** 'pending' = no rung filled yet; 'open' = at least one rung filled. */
  status: "pending" | "open";
}

export interface ConcurrencyDecision {
  allowed: boolean;
  currentCount: number;
  cap: number;
  reason?: "sweep_concurrency_cap";
}

/**
 * Would deploying a new sweep ladder exceed the concurrency cap?
 * Counts BOTH pending (unfilled) and open (partially/fully filled) ladders.
 */
export function evaluateSweepConcurrency(
  existing: SweepLadderRef[],
  cap: number = SWEEP_H2_MAX_CONCURRENT_LADDERS,
): ConcurrencyDecision {
  const currentCount = existing.length;
  const allowed = currentCount < cap;
  return {
    allowed,
    currentCount,
    cap,
    reason: allowed ? undefined : "sweep_concurrency_cap",
  };
}
