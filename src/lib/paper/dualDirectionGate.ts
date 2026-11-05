/**
 * PAPER DUAL-DIRECTION ELIGIBILITY GATE — pure, deterministic, no I/O.
 *
 * Given a confirmed Scout opportunity, the caller's open positions, wallet
 * ledger, user setting, and venue capability, this gate returns exactly one
 * eligibility code. `ELIGIBLE` means the paper strategy orchestrator MAY
 * open a NEW, independent opposite-direction position. Every other code
 * means the opportunity is `DETECTED_NOT_EXECUTABLE` — Scout still
 * publishes it for display; the engine MUST NOT create an order intent.
 *
 * Isolation guarantees:
 *   • Original ladder is never modified. Its `pending_rungs`,
 *     `resize_levels`, `armed_stop_price`, and `stop_level` are ignored
 *     here except to establish it EXISTS.
 *   • Opposite trade must land on a DIFFERENT wallet with its own
 *     `position_id`, `opKey`, ladder contract, TPs, and budget.
 *   • Feature default is OFF — callers must explicitly enable dual
 *     direction per user (`UserDualDirectionSettings.enabled = true`).
 */
import type { ScoutOpportunity } from "@/lib/scout/opportunity";
import type { Side } from "@/lib/scout/dualDirection";
import type { VenueCapability } from "@/lib/exchanges/venueCapabilities";

export type EligibilityReason =
  | "ELIGIBLE"
  | "DUAL_DIRECTION_OFF"
  | "NO_OPPOSITE_WALLET"
  | "NETTING_CONFLICT"
  | "RISK_CAP"
  | "STALE"
  | "WEAK"
  | "SAME_SIDE_ALREADY_OPEN";

export interface EligibilityDecision {
  reason: EligibilityReason;
  eligible: boolean;
  /** Human-readable label for the UI (uppercase). */
  label: string;
}

export interface UserDualDirectionSettings {
  /** Feature must be explicitly enabled per user. Default OFF. */
  enabled: boolean;
  /** Max margin the opposite trade may commit. Null = no cap. */
  maxOppositeMarginUsd: number | null;
  /** Max combined open margin across all positions for this symbol. Null = no cap. */
  maxSymbolMarginUsd: number | null;
}

export const DEFAULT_DUAL_DIRECTION_SETTINGS: UserDualDirectionSettings = {
  enabled: false,
  maxOppositeMarginUsd: null,
  maxSymbolMarginUsd: null,
};

export interface OpenPositionSummary {
  positionId: string;
  side: Side;
  walletKey: string;
  marginUsd: number;
}

export interface WalletSummary {
  walletKey: string;
  side: Side;
  enabled: boolean;
}

export interface GateInput {
  opportunity: ScoutOpportunity;
  openPositionsForSymbol: readonly OpenPositionSummary[];
  walletsForSymbol: readonly WalletSummary[];
  userSettings: UserDualDirectionSettings;
  venue: VenueCapability;
  /** Proposed margin the caller intends to commit to the opposite trade. */
  proposedOppositeMarginUsd: number;
}

function decide(reason: EligibilityReason): EligibilityDecision {
  return {
    reason,
    eligible: reason === "ELIGIBLE",
    label: reason === "ELIGIBLE" ? "ELIGIBLE" : reason.replace(/_/g, " "),
  };
}

/**
 * Deterministic eligibility gate. Order of checks is fixed and documented
 * — the first failing check wins so tests can pin exact failure codes.
 */
export function evaluateDualDirectionEligibility(input: GateInput): EligibilityDecision {
  const { opportunity, openPositionsForSymbol, walletsForSymbol, userSettings, venue, proposedOppositeMarginUsd } = input;

  // 1. Detection freshness / strength — Scout invariants, checked first so a
  //    stale/weak signal cannot slip through even if the user has dual
  //    direction on.
  if (opportunity.state !== "confirmed") return decide("WEAK");
  if (!opportunity.fresh) return decide("STALE");

  // 2. User pref must be explicitly ON (feature default OFF).
  if (!userSettings.enabled) return decide("DUAL_DIRECTION_OFF");

  // 3. Venue must support simultaneous long+short without netting.
  if (!venue.supportsSimultaneousLongShort || venue.hedgeMode === "one_way") {
    return decide("NETTING_CONFLICT");
  }

  // 4. An OPPOSITE-direction wallet must exist and be enabled.
  const oppositeWallet = walletsForSymbol.find(
    (w) => w.side === opportunity.side && w.enabled,
  );
  if (!oppositeWallet) return decide("NO_OPPOSITE_WALLET");

  // 5. The opposite side must not already have an open ladder — this
  //    prevents accidental stacking on the same wallet.
  const sameSideAlreadyOpen = openPositionsForSymbol.some(
    (p) => p.side === opportunity.side,
  );
  if (sameSideAlreadyOpen) return decide("SAME_SIDE_ALREADY_OPEN");

  // 6. Risk caps: per-opposite cap + combined symbol cap. The opposite
  //    trade must not push either ceiling over.
  if (
    userSettings.maxOppositeMarginUsd != null &&
    proposedOppositeMarginUsd > userSettings.maxOppositeMarginUsd
  ) {
    return decide("RISK_CAP");
  }
  if (userSettings.maxSymbolMarginUsd != null) {
    const currentSymbolMargin = openPositionsForSymbol.reduce(
      (sum, p) => sum + (Number.isFinite(p.marginUsd) ? p.marginUsd : 0),
      0,
    );
    if (currentSymbolMargin + proposedOppositeMarginUsd > userSettings.maxSymbolMarginUsd) {
      return decide("RISK_CAP");
    }
  }

  return decide("ELIGIBLE");
}
