import { describe, expect, it } from "vitest";
import {
  buildWalletCampaignLadder,
  sizeWalletCampaign,
  WALLET_CAMPAIGN_MARGIN_FRACTION,
  WALLET_CAMPAIGN_RUNG_COUNT,
} from "../walletCampaignSizing";

describe("universal wallet campaign sizing", () => {
  it("uses five percent of the latest settled wallet balance", () => {
    expect(WALLET_CAMPAIGN_MARGIN_FRACTION).toBe(0.05);
    expect(WALLET_CAMPAIGN_RUNG_COUNT).toBe(5);

    for (const [balance, total, perRung] of [
      [1_000, 50, 10],
      [2_500, 125, 25],
      [3_000, 150, 30],
      [5_000, 250, 50],
    ]) {
      const result = sizeWalletCampaign({ settledWalletBalance: balance, leverage: 50 });
      expect(result.targetMargin).toBe(total);
      expect(result.committedMargin).toBe(total);
      expect(result.marginPerRung).toBe(perRung);
      expect(result.rungCount).toBe(5);
      expect(result.cappedBy).toBe("none");
    }
  });

  it("builds exactly five equal-margin rungs", () => {
    const result = buildWalletCampaignLadder({
      settledWalletBalance: 3_000,
      leverage: 50,
      direction: "long",
      signalPrice: 100,
    });
    expect(result.rungs).toHaveLength(5);
    expect(result.rungs.every((rung) => rung.margin === 30)).toBe(true);
    expect(result.rungs.reduce((sum, rung) => sum + rung.margin, 0)).toBe(150);
  });

  it("compounds from the wallet balance after a settled trade", () => {
    const before = sizeWalletCampaign({ settledWalletBalance: 2_500, leverage: 50 });
    const after = sizeWalletCampaign({ settledWalletBalance: 2_600, leverage: 50 });

    expect(before.committedMargin).toBe(125);
    expect(before.marginPerRung).toBe(25);
    expect(after.committedMargin).toBe(130);
    expect(after.marginPerRung).toBe(26);
  });

  it("never exceeds exchange notional or available-collateral limits", () => {
    const venueCapped = sizeWalletCampaign({
      settledWalletBalance: 5_000,
      leverage: 100,
      venueRemainingNotional: 10_000,
    });
    expect(venueCapped.targetMargin).toBe(250);
    expect(venueCapped.committedMargin).toBe(100);
    expect(venueCapped.marginPerRung).toBe(20);
    expect(venueCapped.cappedBy).toBe("venue_notional");

    const collateralCapped = sizeWalletCampaign({
      settledWalletBalance: 5_000,
      leverage: 50,
      availableCollateral: 75,
    });
    expect(collateralCapped.committedMargin).toBe(75);
    expect(collateralCapped.marginPerRung).toBe(15);
    expect(collateralCapped.cappedBy).toBe("available_collateral");
  });

  it("fails closed on invalid wallet or leverage inputs", () => {
    expect(sizeWalletCampaign({ settledWalletBalance: 0, leverage: 50 }).committedMargin).toBe(0);
    expect(sizeWalletCampaign({ settledWalletBalance: 1_000, leverage: 0 }).committedMargin).toBe(0);
  });
});
