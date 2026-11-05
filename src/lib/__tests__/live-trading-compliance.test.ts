import { describe, expect, it } from "vitest";

import {
  canAutomateMainnet,
  canSubmitMainnetOrder,
  type MainnetFlagSnapshot,
} from "../../../supabase/functions/_shared/mainnet-flags";
import {
  CUSTOMER_LIVE_TRADING_AVAILABLE,
  CUSTOMER_LIVE_TRADING_BLOCK_REASON,
  canUseInternalLiveTrading,
} from "../live-trading-policy";

const allTechnicalFlagsOn: MainnetFlagSnapshot = {
  reads: true,
  signer: true,
  canary: true,
  automation: true,
  complianceApproved: false,
};

describe("live-trading compliance gate", () => {
  it("keeps customer live trading unavailable in the app", () => {
    expect(CUSTOMER_LIVE_TRADING_AVAILABLE).toBe(false);
    expect(CUSTOMER_LIVE_TRADING_BLOCK_REASON).toMatch(/jurisdiction and licensing/i);
    expect(canUseInternalLiveTrading(false)).toBe(false);
  });

  it("allows the owner-only internal pilot without opening customer live trading", () => {
    expect(canUseInternalLiveTrading(true)).toBe(true);
    expect(CUSTOMER_LIVE_TRADING_AVAILABLE).toBe(false);
  });

  it("blocks manual and automated orders when technical flags are on but compliance is not approved", () => {
    expect(canSubmitMainnetOrder(allTechnicalFlagsOn)).toBe(false);
    expect(canAutomateMainnet(allTechnicalFlagsOn)).toBe(false);
  });

  it("requires compliance approval in addition to every execution flag", () => {
    const approved = { ...allTechnicalFlagsOn, complianceApproved: true };
    expect(canSubmitMainnetOrder(approved)).toBe(true);
    expect(canAutomateMainnet(approved)).toBe(true);
    expect(canAutomateMainnet({ ...approved, automation: false })).toBe(false);
  });
});
