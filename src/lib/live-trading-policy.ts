/**
 * Customer live execution is intentionally unavailable until TurtleBot has
 * an approved jurisdiction and licensing policy. User self-attestation alone
 * must never enable real-money trading.
 */
export const CUSTOMER_LIVE_TRADING_AVAILABLE = false;

/** Phase 1 product surface. Legacy venue desks remain in the repository for
 * attribution and future work, but are not reachable from the Quorumark MVP. */
export const QUORUMARK_MVP_SURFACES_ONLY = true;

export const CUSTOMER_LIVE_TRADING_BLOCK_REASON =
  "Live execution is unavailable pending jurisdiction and licensing approval. Read-only account monitoring remains available.";

/**
 * Company testing is a separate, owner-only surface. Database triggers still
 * reject live strategy rows and real-money order intents for every non-admin,
 * so this client decision cannot grant execution authority by itself.
 */
export function canUseInternalLiveTrading(isOwner: boolean): boolean {
  return CUSTOMER_LIVE_TRADING_AVAILABLE || isOwner;
}

export function liveTradingAvailabilityCopy(isOwner: boolean): string {
  return canUseInternalLiveTrading(isOwner)
    ? "Internal live pilot. Only the owner account can route real orders; worker, signer, canary and risk gates still apply."
    : CUSTOMER_LIVE_TRADING_BLOCK_REASON;
}
