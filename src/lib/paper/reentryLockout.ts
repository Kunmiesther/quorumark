/**
 * Re-entry lockout — post-guardian-BOS entry-side guard.
 *
 * After any Guardian-driven close (`scout_bos`, `scout_guardian_bos`, or
 * `scout_guardian_cluster`), the paper engine MUST refuse a new entry on the
 * same `(symbol, direction)` for `REENTRY_LOCKOUT_CANDLES` completed 15m
 * candles. The opposite direction is NEVER blocked, and unrelated symbols are
 * unaffected. This closes the "cut → immediately re-enter → cut again" loop
 * the owner reported (LINK-LONG cut 3× in 30 min).
 *
 * PURE — no I/O. The engine (or a caller) supplies:
 *   - a list of recent Guardian-flagged trades `{ symbol, direction, closed_at_ms }`
 *   - the current tick's `nowMs`
 *
 * The window is expressed in candles (via `REENTRY_LOCKOUT_CANDLES` in the
 * shared parity JSON) so the TS engine and the Python live worker consume the
 * SAME constant. See `docs/MAINNET_PARITY.md` for the mirror obligation.
 */
import { ENTRY_LOCKOUT } from "./parityConstants";
import { INTERVAL_MIN } from "./constants";

/** Guardian-driven close reasons that trigger the lockout. */
export const LOCKOUT_TRIGGER_REASONS: readonly string[] = [
  "scout_bos",
  "scout_guardian_bos",
  "scout_guardian_cluster",
];

/** Lockout window in execution candles, sourced from shared parity constants. */
export const REENTRY_LOCKOUT_CANDLES: number =
  ENTRY_LOCKOUT.reentry_lockout_candles;

/** Lockout window in ms — REENTRY_LOCKOUT_CANDLES × INTERVAL_MIN × 60_000. */
export const REENTRY_LOCKOUT_MS: number =
  REENTRY_LOCKOUT_CANDLES * INTERVAL_MIN * 60_000;

export type LockoutKey = string; // `${symbol}:${direction}`

export function lockoutKey(symbol: string, direction: "long" | "short"): LockoutKey {
  return `${symbol}:${direction}`;
}

export interface LockoutTradeRow {
  symbol: string;
  direction: "long" | "short" | string;
  exit_reason: string;
  closed_at_ms: number;
}

/**
 * Build the set of `(symbol, direction)` keys currently under re-entry
 * lockout given a bundle of recent Guardian-flagged trades and the current
 * tick timestamp. A trade contributes to the set iff:
 *   1. exit_reason is one of LOCKOUT_TRIGGER_REASONS
 *   2. direction is "long" or "short"
 *   3. `nowMs - closed_at_ms < REENTRY_LOCKOUT_MS`
 */
export function buildLockoutSet(
  trades: readonly LockoutTradeRow[],
  nowMs: number,
): Set<LockoutKey> {
  const out = new Set<LockoutKey>();
  const triggers = new Set(LOCKOUT_TRIGGER_REASONS);
  for (const t of trades) {
    if (!triggers.has(t.exit_reason)) continue;
    if (t.direction !== "long" && t.direction !== "short") continue;
    if (!Number.isFinite(t.closed_at_ms)) continue;
    if (nowMs - t.closed_at_ms >= REENTRY_LOCKOUT_MS) continue;
    out.add(lockoutKey(t.symbol, t.direction));
  }
  return out;
}

export function isLockedOut(
  set: ReadonlySet<LockoutKey>,
  symbol: string,
  direction: "long" | "short",
): boolean {
  return set.has(lockoutKey(symbol, direction));
}
