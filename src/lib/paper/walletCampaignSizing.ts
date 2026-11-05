/**
 * Universal wallet-level campaign sizing.
 *
 * Strategy detectors decide *whether* an opportunity exists. They do not own
 * capital sizing. Every new campaign receives the same wallet contract:
 * 5% of the destination wallet's latest settled balance, frozen at campaign
 * creation and divided equally across five rungs. A venue notional ceiling,
 * when known, may reduce that amount but can never increase it.
 */
import { ORCHESTRATION } from "./parityConstants";
import { buildLadder, type Rung } from "./ladder";
import type { Direction } from "./signal";

export const WALLET_CAMPAIGN_MARGIN_FRACTION =
  ORCHESTRATION.campaign_margin_fraction_of_settled_wallet_balance;
export const WALLET_CAMPAIGN_RUNG_COUNT = ORCHESTRATION.campaign_rung_count;

export interface WalletCampaignSizingInput {
  settledWalletBalance: number;
  leverage: number;
  /** Remaining venue position notional for this symbol, when available. */
  venueRemainingNotional?: number | null;
  /** Spendable collateral after existing reservations, when available. */
  availableCollateral?: number | null;
}

export interface WalletCampaignSizing {
  targetMargin: number;
  committedMargin: number;
  marginPerRung: number;
  rungCount: number;
  cappedBy: "none" | "venue_notional" | "available_collateral";
}

export function sizeWalletCampaign(input: WalletCampaignSizingInput): WalletCampaignSizing {
  const settled = Number(input.settledWalletBalance);
  const leverage = Number(input.leverage);
  const rungCount = WALLET_CAMPAIGN_RUNG_COUNT;
  if (!(settled > 0) || !(leverage > 0) || rungCount !== 5) {
    return { targetMargin: 0, committedMargin: 0, marginPerRung: 0, rungCount, cappedBy: "none" };
  }

  const targetMargin = settled * WALLET_CAMPAIGN_MARGIN_FRACTION;
  let committedMargin = targetMargin;
  let cappedBy: WalletCampaignSizing["cappedBy"] = "none";

  const available = Number(input.availableCollateral);
  if (input.availableCollateral != null && Number.isFinite(available) && available >= 0 && available < committedMargin) {
    committedMargin = available;
    cappedBy = "available_collateral";
  }

  const remainingNotional = Number(input.venueRemainingNotional);
  if (input.venueRemainingNotional != null && Number.isFinite(remainingNotional) && remainingNotional >= 0) {
    const venueMarginCap = remainingNotional / leverage;
    if (venueMarginCap < committedMargin) {
      committedMargin = venueMarginCap;
      cappedBy = "venue_notional";
    }
  }

  committedMargin = Math.max(0, committedMargin);
  return {
    targetMargin,
    committedMargin,
    marginPerRung: committedMargin / rungCount,
    rungCount,
    cappedBy,
  };
}

export function buildWalletCampaignLadder(input: WalletCampaignSizingInput & {
  direction: Direction;
  signalPrice: number;
  atr?: number | null;
}): { sizing: WalletCampaignSizing; rungs: Rung[] } {
  const sizing = sizeWalletCampaign(input);
  if (!(sizing.marginPerRung > 0) || !(input.signalPrice > 0)) {
    return { sizing, rungs: [] };
  }
  return {
    sizing,
    rungs: buildLadder(
      input.direction,
      input.signalPrice,
      input.atr,
      input.leverage,
      sizing.marginPerRung,
      sizing.rungCount,
    ),
  };
}
