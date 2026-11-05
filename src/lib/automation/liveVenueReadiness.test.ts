import { describe, expect, it } from "vitest";
import { executionReadyConnections, hasRunningLiveStrategy, liveAutomationReason, verifiedAutomationVenue, type LiveVenueConnection } from "./liveVenueReadiness";

const aster: LiveVenueConnection = { id: "aster-wallet", exchange: "aster", environment: "mainnet", status: "verified", permission_trade: true, permissions_verified: true, is_live: true };
const apex = { ...aster, id: "apex-wallet", exchange: "apex_omni" };
const row = { connection_id: aster.id, enabled: true, mode: "live" };

describe("independent venue readiness", () => {
  it("does not require an ApeX signing record for verified Aster credentials", () => {
    expect(executionReadyConnections([aster, apex], [])).toEqual([aster]);
    expect(executionReadyConnections([apex], [{ exchange_connection_id: apex.id, environment: "mainnet", active: true, revoked_at: null }])).toEqual([apex]);
  });
  it("requires an active matching ApeX signing record", () => {
    expect(executionReadyConnections([apex], [{ exchange_connection_id: aster.id, environment: "mainnet", active: true, revoked_at: null }])).toEqual([]);
  });
  it("rejects unsupported, unverified and testnet routes", () => {
    expect(verifiedAutomationVenue({ ...aster, exchange: "synfutures" })).toBe(false);
    expect(verifiedAutomationVenue({ ...aster, permissions_verified: false })).toBe(false);
    expect(executionReadyConnections([{ ...aster, environment: "testnet" }], [])).toEqual([]);
  });
  it("does not call paused connections running even with enabled strategy rows", () => {
    expect(hasRunningLiveStrategy([{ ...aster, is_live: false }], [row], { aster: true })).toBe(false);
  });
  it("does not borrow another wallet's strategy or another venue's runtime", () => {
    expect(hasRunningLiveStrategy([aster], [{ ...row, connection_id: apex.id }], { aster: true })).toBe(false);
    expect(hasRunningLiveStrategy([aster], [row], { apex_omni: true, aster: false })).toBe(false);
  });
  it("checks all rows rather than only the first symbol", () => {
    expect(hasRunningLiveStrategy([aster], [{ ...row, enabled: false }, row], { aster: true })).toBe(true);
  });
  it("points an armed but paused account to Resume instead of rearming", () => {
    expect(liveAutomationReason([{ ...aster, is_live: false }], [row], { aster: true })).toContain("exchange is paused");
  });
  it("does not report readiness from a different exchange", () => {
    expect(liveAutomationReason([aster], [row], { apex_omni: true })).toContain("not ready");
    expect(liveAutomationReason([aster], [], { aster: true })).toContain("Review and arm");
  });
});
