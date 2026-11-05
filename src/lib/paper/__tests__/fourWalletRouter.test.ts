import { describe, expect, it } from "vitest";
import {
  PAPER_WALLET_ROLES,
  aiSelectionSymbolAvailable,
  campaignSlotKey,
  routeFourWalletOpportunity,
} from "../fourWalletRouter";

describe("four-wallet opportunity routing", () => {
  it("defines exactly the four owner-approved wallet roles", () => {
    expect(PAPER_WALLET_ROLES).toEqual(["long", "short", "hedge", "strategy"]);
  });

  it("routes a 2-of-3 long directly to the Long wallet without AI", () => {
    expect(routeFourWalletOpportunity({
      symbol: "ETH-USDT",
      direction: "long",
      alignmentStates: ["bullish_bos", "none", "bullish_bos"],
      openCampaigns: [],
    })).toEqual({
      accepted: true,
      selectionPath: "core_2_of_3",
      walletKey: "long",
      executionStrategy: "native",
    });
  });

  it("routes a 2-of-3 short directly to the Short wallet without AI", () => {
    expect(routeFourWalletOpportunity({
      symbol: "SOL-USDT",
      direction: "short",
      alignmentStates: ["bearish_bos", "bearish_bos", "none"],
      openCampaigns: [],
    })).toMatchObject({ selectionPath: "core_2_of_3", walletKey: "short" });
  });

  it("hands a failed alignment to Council then Onyx for Strategy-wallet DCA", () => {
    expect(routeFourWalletOpportunity({
      symbol: "XRP-USDT",
      direction: "long",
      alignmentStates: ["bullish_bos", "none", "bearish_bos"],
      openCampaigns: [],
    })).toEqual({
      accepted: true,
      selectionPath: "council_then_onyx",
      walletKey: "strategy",
      executionStrategy: "dca",
    });
  });

  it("blocks Council and Onyx when any wallet already holds the symbol", () => {
    const openCampaigns = [{ symbol: "BTC-USDT", walletKey: "long", direction: "long" as const }];
    expect(aiSelectionSymbolAvailable("BTC-USDT", openCampaigns)).toBe(false);
    expect(routeFourWalletOpportunity({
      symbol: "BTC-USDT",
      direction: "short",
      alignmentStates: ["none", "none", "none"],
      openCampaigns,
    })).toEqual({ accepted: false, reason: "symbol_already_open" });
  });

  it("routes only a confirmed opposite-to-core opportunity to the Hedge wallet", () => {
    const openCampaigns = [{ symbol: "ETH-USDT", walletKey: "long", direction: "long" as const }];
    expect(routeFourWalletOpportunity({
      symbol: "ETH-USDT",
      direction: "short",
      alignmentStates: ["bearish_bos", "none", "bearish_bos"],
      openCampaigns,
      hedgeRequired: true,
    })).toEqual({
      accepted: true,
      selectionPath: "hedge_protection",
      walletKey: "hedge",
      executionStrategy: "native",
    });
    expect(routeFourWalletOpportunity({
      symbol: "ETH-USDT",
      direction: "short",
      alignmentStates: ["bearish_bos", "none", "bearish_bos"],
      openCampaigns,
      hedgeRequired: false,
    })).toEqual({ accepted: false, reason: "symbol_already_open" });
  });

  it("never stacks a second Hedge campaign on the symbol", () => {
    const openCampaigns = [
      { symbol: "ETH-USDT", walletKey: "long", direction: "long" as const },
      { symbol: "ETH-USDT", walletKey: "hedge", direction: "short" as const },
    ];
    expect(routeFourWalletOpportunity({
      symbol: "ETH-USDT",
      direction: "short",
      alignmentStates: ["bearish_bos", "bearish_bos", "none"],
      openCampaigns,
      hedgeRequired: true,
    })).toEqual({ accepted: false, reason: "symbol_already_open" });
  });

  it("keeps separate symbol campaign slots inside a role wallet", () => {
    expect(campaignSlotKey("long", "ETH-USDT")).toBe("long:ETH-USDT");
    expect(campaignSlotKey("long", "BTC-USDT")).not.toBe(campaignSlotKey("long", "ETH-USDT"));
  });
});
