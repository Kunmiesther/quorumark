import type { Direction } from "./signal";
import {
  CANONICAL_SCAN_SYMBOL_SET,
  passesZenSweepAlignment,
  type AlignmentState,
} from "./zenSweepContract";

export const PAPER_WALLET_ROLES = ["long", "short", "hedge", "strategy"] as const;
export type PaperWalletRole = (typeof PAPER_WALLET_ROLES)[number];

export type SelectionPath = "core_2_of_3" | "hedge_protection" | "council_then_onyx";

export interface OpenCampaignRef {
  symbol: string;
  walletKey: string;
  direction: Direction;
}

export type OpportunityRoute =
  | {
      accepted: true;
      selectionPath: "core_2_of_3";
      walletKey: "long" | "short";
      executionStrategy: "native";
    }
  | {
      accepted: true;
      selectionPath: "council_then_onyx";
      walletKey: "strategy";
      executionStrategy: "dca";
    }
  | {
      accepted: true;
      selectionPath: "hedge_protection";
      walletKey: "hedge";
      executionStrategy: "native";
    }
  | {
      accepted: false;
      reason: "symbol_outside_scan" | "symbol_already_open";
    };

/**
 * The one entry router for the four-wallet paper portfolio.
 *
 * Aligned opportunities are mechanical and never enter the AI pipeline.
 * A failed 2-of-3 alignment is not discarded: it is handed to Council, then
 * Onyx, and an approval executes as DCA in the single Strategy wallet.
 */
export function routeFourWalletOpportunity(input: {
  symbol: string;
  direction: Direction;
  alignmentStates: readonly AlignmentState[];
  openCampaigns: readonly OpenCampaignRef[];
  /** Confirmed opposing regime; only meaningful against an open core trade. */
  hedgeRequired?: boolean;
}): OpportunityRoute {
  if (!CANONICAL_SCAN_SYMBOL_SET.has(input.symbol)) {
    return { accepted: false, reason: "symbol_outside_scan" };
  }
  const sameSymbol = input.openCampaigns.filter((position) => position.symbol === input.symbol);
  const oppositeCore = sameSymbol.find((position) =>
    (position.walletKey === "long" || position.walletKey === "short")
    && position.direction !== input.direction,
  );
  const hedgeAlreadyOpen = sameSymbol.some((position) => position.walletKey === "hedge");
  if (input.hedgeRequired && oppositeCore && !hedgeAlreadyOpen) {
    return {
      accepted: true,
      selectionPath: "hedge_protection",
      walletKey: "hedge",
      executionStrategy: "native",
    };
  }
  if (sameSymbol.length > 0) {
    return { accepted: false, reason: "symbol_already_open" };
  }
  if (passesZenSweepAlignment(input.direction, input.alignmentStates)) {
    return {
      accepted: true,
      selectionPath: "core_2_of_3",
      walletKey: input.direction,
      executionStrategy: "native",
    };
  }
  return {
    accepted: true,
    selectionPath: "council_then_onyx",
    walletKey: "strategy",
    executionStrategy: "dca",
  };
}

/** Council and Onyx both re-check the same global symbol lock. */
export function aiSelectionSymbolAvailable(
  symbol: string,
  openCampaigns: readonly OpenCampaignRef[],
): boolean {
  return CANONICAL_SCAN_SYMBOL_SET.has(symbol)
    && !openCampaigns.some((position) => position.symbol === symbol);
}

export function campaignSlotKey(walletKey: string, symbol: string): string {
  return `${walletKey}:${symbol}`;
}
