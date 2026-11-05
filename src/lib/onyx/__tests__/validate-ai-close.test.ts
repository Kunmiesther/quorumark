/**
 * Deterministic-validator regression tests for the mid-ladder DCA hold policy.
 *
 * These cover the ORIGINAL LIVE FAILURE: BTC/ETH 100× DCA closed via
 * onyx_cut after only ~1% adverse move with 7/8 rungs still pending. The
 * validator now rejects every such request; every close must independently
 * satisfy either bank_profit or scout_bos.
 */
import { describe, it, expect } from "vitest";
import {
  decideOnyxForCandidates,
  validateAiClose,
  type OnyxOpenPosition,
  type FleetSnapshot,
} from "../decide";
import { ONYX_BANK_PROFIT_MARGIN_ROI_PCT } from "@/lib/paper/constants";

const baseFleet: FleetSnapshot = {
  walletCount: 24, openCount: 1, altOpenCount: 0, freeWalletCount: 7,
  benchedWallets: [], maxTotalOpen: 8, maxAltPositions: 6, benchConsecutiveStops: 3,
};

function btcDcaFirstRungRed(pnlPctOfMargin: number, pending: number): OnyxOpenPosition {
  return {
    walletKey: "BTC-long", positionId: "pos-btc-1",
    symbol: "BTC-USDT", base: "BTC", direction: "long", strategy: "dca",
    entryPx: 60_000, worstPx: 59_400, markPx: 59_400,
    qty: 0.000125, margin: 60,
    pnlPctOfMargin, ageMinutes: 4,
    regime: "trend", trendState: "up", trendSlopePct: 0.2,
    structureBroken: false,
    filledRungCount: 8 - pending, pendingRungCount: pending, totalPlannedRungs: 8,
    perRungMargin: 7.5, totalPlannedMargin: 60,
    deepestRungPrice: 59_400, hardStopLevel: 59_400,
    nextRungPrice: 59_800,
  };
}

const okFetchWithCloses = (closes: Array<{ position_id: string; rationale: string }>): typeof fetch =>
  (async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ deploys: [], closes, narrative: "trying to cut" }) } }],
  }), { status: 200 })) as unknown as typeof fetch;

describe("validateAiClose — mid-ladder DCA hold policy", () => {
  it("REJECTS close on 1st rung filled, 7 pending, red -80%", () => {
    const v = validateAiClose(btcDcaFirstRungRed(-80, 7));
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toBe("pending_rungs_active");
  });

  it("REJECTS close on partial ladder (4/8 filled, red -40%)", () => {
    const v = validateAiClose(btcDcaFirstRungRed(-40, 4));
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toBe("pending_rungs_active");
  });

  it("REJECTS close on full ladder (0 pending) that is not profitable enough", () => {
    const v = validateAiClose(btcDcaFirstRungRed(5, 0));
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toBe("not_profitable_enough");
  });

  it("APPROVES bank_profit close when pnl ≥ threshold, even mid-ladder", () => {
    const v = validateAiClose(btcDcaFirstRungRed(ONYX_BANK_PROFIT_MARGIN_ROI_PCT + 1, 5));
    expect(v.allowed).toBe(true);
    if (v.allowed) expect(v.reason).toBe("bank_profit");
  });

  it("APPROVES bank_profit close exactly at threshold", () => {
    const v = validateAiClose(btcDcaFirstRungRed(ONYX_BANK_PROFIT_MARGIN_ROI_PCT, 0));
    expect(v.allowed).toBe(true);
  });
});

describe("decideOnyxForCandidates — AI closes disabled (ONYX_AI_ENABLED=false)", () => {
  it("never executes an AI-proposed close for a mid-ladder red DCA (7 pending)", async () => {
    const pos = btcDcaFirstRungRed(-80, 7);
    const d = await decideOnyxForCandidates(
      [], baseFleet, "k",
      okFetchWithCloses([{ position_id: pos.positionId, rationale: "cut it, it's red" }]),
      [pos],
    );
    expect(d.aiCalled).toBe(false);
    expect(d.closes).toEqual([]);
    // AI disabled: no AI-originated close arrives at the validator, so
    // rejectedCloses stays empty (harmless logging code kept in place).
    expect(d.rejectedCloses).toEqual([]);
  });

  it("never executes an AI-proposed bank_profit close even when validator would allow", async () => {
    const pos = btcDcaFirstRungRed(ONYX_BANK_PROFIT_MARGIN_ROI_PCT + 5, 0);
    const d = await decideOnyxForCandidates(
      [], baseFleet, "k",
      okFetchWithCloses([{ position_id: pos.positionId, rationale: "bank it" }]),
      [pos],
    );
    expect(d.aiCalled).toBe(false);
    expect(d.closes).toEqual([]);
    expect(d.rejectedCloses).toEqual([]);
  });

  it("Guardian v2: engine no longer force-closes on structure_broken (worker is sole BOS authority)", async () => {
    const pos = btcDcaFirstRungRed(-50, 7);
    const posBroken: OnyxOpenPosition = { ...pos, structureBroken: true, brokenLevel: 59_900 };
    const d = await decideOnyxForCandidates(
      [], baseFleet, "k",
      okFetchWithCloses([{ position_id: pos.positionId, rationale: "cut" }]),
      [posBroken],
    );
    expect(d.aiCalled).toBe(false);
    // structure_broken is telemetry-only in v2; the close must come from a
    // scout_guardian_directives row consumed by the engine, not from Onyx.
    expect(d.closes).toEqual([]);
  });

  it("ignores AI-only unknown position ids (nothing arrives at validator)", async () => {
    const pos = btcDcaFirstRungRed(-10, 3);
    const d = await decideOnyxForCandidates(
      [], baseFleet, "k",
      okFetchWithCloses([{ position_id: "does-not-exist", rationale: "ghost" }]),
      [pos],
    );
    expect(d.aiCalled).toBe(false);
    expect(d.closes).toEqual([]);
    expect(d.rejectedCloses).toEqual([]);
  });
});

