import { describe, expect, it } from "vitest";
import { AutomationOrderSchema, automationSignerPurpose, unsupportedCampaignReason } from "../automationOrder";

const valid = {
  user_id: "00000000-0000-4000-8000-000000000001",
  connection_id: "00000000-0000-4000-8000-000000000002",
  venue: "apex_omni",
  symbol: "ETH-USDT",
  side: "BUY",
  order_type: "MARKET",
  size: 0.1,
  leverage: 5,
  purpose: "CREATE_ORDER",
  idempotency_key: "decision-12345678",
  is_live: true,
};

describe("automation order contract", () => {
  it("accepts the worker's compact entry identity on both venues", () => {
    // Shared golden vector with tests/test_order_identity.py: the rejected
    // 83-character Accumulator identity, encoded without dropping its scope.
    const idempotency_key = "tb1:6580bc5879a712158c2c789b5e4fcc1699e2a30fc0adc65a98bf1388fdb2";
    for (const venue of ["apex_omni", "aster"]) {
      expect(AutomationOrderSchema.safeParse({ ...valid, venue, idempotency_key }).success).toBe(true);
      expect(AutomationOrderSchema.safeParse({ ...valid, venue, idempotency_key: "x".repeat(83) }).success).toBe(false);
    }
  });

  it("accepts the worker's credential-free intent", () => {
    expect(AutomationOrderSchema.safeParse(valid).success).toBe(true);
  });

  it("requires explicit live intent and the supported universe", () => {
    expect(AutomationOrderSchema.safeParse({ ...valid, is_live: false }).success).toBe(false);
    expect(AutomationOrderSchema.safeParse({ ...valid, symbol: "DOGE-USDT" }).success).toBe(false);
  });

  it("rejects credential material and unknown fields", () => {
    expect(AutomationOrderSchema.safeParse({ ...valid, api_secret: "never" }).success).toBe(false);
  });

  it("recognizes Aster separately and rejects unsupported SynFutures", () => {
    expect(AutomationOrderSchema.safeParse({ ...valid, venue: "aster" }).success).toBe(true);
    expect(AutomationOrderSchema.safeParse({ ...valid, venue: "synfutures" }).success).toBe(false);
  });

  it("allows Aster up to 125x without raising ApeX's 100x ceiling", () => {
    expect(AutomationOrderSchema.safeParse({ ...valid, venue: "aster", leverage: 125 }).success).toBe(true);
    for (const leverage of [126, 135, 200, 125.5, true]) {
      expect(AutomationOrderSchema.safeParse({ ...valid, venue: "aster", leverage }).success).toBe(false);
    }
    expect(AutomationOrderSchema.safeParse({ ...valid, leverage: 100 }).success).toBe(true);
    expect(AutomationOrderSchema.safeParse({ ...valid, leverage: 101 }).success).toBe(false);
    expect(AutomationOrderSchema.safeParse({ ...valid, leverage: 125 }).success).toBe(false);
  });

  it("only accepts a signer-sized five-rung Aster entry", () => {
    const aster = AutomationOrderSchema.parse({
      ...valid, venue: "aster", size: undefined, campaign_rung_count: 5,
    });
    expect(unsupportedCampaignReason(aster)).toBeNull();
    expect(automationSignerPurpose(aster)).toBe("AUTOMATED_ENTRY");
    expect(unsupportedCampaignReason({ ...aster, size: 0.1 })).toBe("ASTER_FIVE_RUNG_ENTRY_REQUIRED");
    expect(unsupportedCampaignReason({ ...aster, reduce_only: true })).toBe("ASTER_REDUCE_ONLY_EXIT_REQUIRED");
    expect(unsupportedCampaignReason({ ...aster, campaign_rung_count: 1 })).toBe("ASTER_FIVE_RUNG_ENTRY_REQUIRED");
    expect(unsupportedCampaignReason({ ...aster, leverage: undefined })).toBe("ASTER_FIVE_RUNG_ENTRY_REQUIRED");
    expect(unsupportedCampaignReason({ ...aster, stop_pct: 0.01 })).toBe("ASTER_FIVE_RUNG_ENTRY_REQUIRED");
  });

  it("routes a sized Aster reduce-only exit without the entry campaign or leverage", () => {
    const close = AutomationOrderSchema.parse({ ...valid, venue: "aster", reduce_only: true, leverage: undefined });
    expect(unsupportedCampaignReason(close)).toBeNull();
    expect(automationSignerPurpose(close)).toBe("CLOSE_POSITION");
    expect(unsupportedCampaignReason({ ...close, leverage: 125 })).toBe("ASTER_REDUCE_ONLY_EXIT_REQUIRED");
    expect(unsupportedCampaignReason({ ...close, size: undefined })).toBe("ASTER_REDUCE_ONLY_EXIT_REQUIRED");
  });

  it("does not let automation select a signer protection exemption", () => {
    const proof = AutomationOrderSchema.parse({ ...valid, purpose: "proof_of_life" });
    expect(automationSignerPurpose(proof)).toBe("AUTOMATED_ENTRY");
    expect(automationSignerPurpose({ ...proof, reduce_only: true })).toBe("CLOSE_POSITION");
  });

  it("accepts exactly five-rung campaigns and refuses incomplete entries", () => {
    const campaign = AutomationOrderSchema.parse({
      ...valid,
      campaign_rung_count: 5,
      campaign_margin_usd: 125,
      campaign_margin_per_rung_usd: 25,
    });
    expect(unsupportedCampaignReason(campaign)).toBeNull();
    expect(unsupportedCampaignReason({ ...campaign, campaign_rung_count: 1 })).toBe("FIVE_RUNG_CAMPAIGN_REQUIRED");
    expect(unsupportedCampaignReason({ ...campaign, campaign_rung_count: undefined })).toBe("FIVE_RUNG_CAMPAIGN_REQUIRED");
    expect(unsupportedCampaignReason({ ...campaign, reduce_only: true })).toBeNull();
    expect(unsupportedCampaignReason({ ...campaign, purpose: "proof_of_life", size: 0.001, campaign_rung_count: undefined })).toBeNull();
    expect(unsupportedCampaignReason({ ...campaign, purpose: "proof_of_life", size: 0.002, campaign_rung_count: undefined })).toBe("FIVE_RUNG_CAMPAIGN_REQUIRED");
  });
});
