/**
 * Regression suite for the ladder-aware hard-stop invariant.
 *
 * The invariant (owner-ratified): a strategy hard stop must NEVER close a
 * laddered position while fewer than the configured final rung has actually
 * filled. Once the actual final rung fills, arm the stop at ±1% of that
 * rung's actual fill price. Pending/rejected rungs never count as filled.
 * Safety overrides (kill_switch / liquidation / manual / account_guard /
 * scout_bos) remain active at all times and carry precise exit_reason codes
 * — they never masquerade as "hard_stop".
 *
 * These tests exercise the PURE policy module + the label helper + the
 * grouping helper. They do not stand up the engine, DB, or feed — the
 * engine imports the same primitives so any policy drift caught here is a
 * real drift in production.
 */
import { describe, it, expect } from "vitest";
import {
  isLadderPosition,
  armLadderHardStop,
  candleCrossesArmedStop,
  buildArmingPayload,
  LADDER_STRATEGIES,
  LADDER_CONTRACT_VERSION,
} from "../ladder-policy";
import { exitReasonLabel, groupPaperTrades, type RawPaperTrade } from "../tradeGrouping";

const ADA_FINAL_FILL = 0.173068;
const BTC_FINAL_FILL = 65000;
const ETH_FINAL_FILL = 3500;

describe("ladder-policy invariant", () => {
  // Test 1
  it("long ladder does not strategy-stop while rungs 1..N-1 remain unfilled", () => {
    // 4-rung ADA long, only 3 rungs filled, candle far below rung 1.
    const decision = armLadderHardStop("long", 3, 4, ADA_FINAL_FILL);
    expect(decision.armed).toBe(false);
    expect(decision.armedStopPrice).toBeNull();
    // Even at a catastrophically low price the strategy stop MUST NOT fire.
    expect(candleCrossesArmedStop("long", 0.15, decision.armedStopPrice)).toBe(false);
  });

  // Test 2
  it("short ladder mirror invariant: does not strategy-stop before final rung fills", () => {
    const decision = armLadderHardStop("short", 3, 4, 100);
    expect(decision.armed).toBe(false);
    expect(decision.armedStopPrice).toBeNull();
    expect(candleCrossesArmedStop("short", 999, decision.armedStopPrice)).toBe(false);
  });

  // Test 3
  it("actual final rung fill arms stop at exactly finalFill × (1 ± 0.01)", () => {
    const long = armLadderHardStop("long", 4, 4, ADA_FINAL_FILL);
    expect(long.armed).toBe(true);
    expect(long.armedStopPrice).not.toBeNull();
    expect(long.armedStopPrice!).toBeCloseTo(ADA_FINAL_FILL * 0.99, 12);
    expect(long.finalRungFillPrice).toBe(ADA_FINAL_FILL);

    const short = armLadderHardStop("short", 4, 4, 100);
    expect(short.armed).toBe(true);
    expect(short.armedStopPrice!).toBeCloseTo(101, 12);
  });

  // Test 4
  it("price above threshold does not fire; price at/crossing threshold fires", () => {
    const decision = armLadderHardStop("long", 4, 4, ADA_FINAL_FILL);
    const armed = decision.armedStopPrice!;
    // 0.5% adverse — well above the armed line — must NOT fire.
    expect(candleCrossesArmedStop("long", ADA_FINAL_FILL * 0.995, armed)).toBe(false);
    // Exactly at the threshold fires.
    expect(candleCrossesArmedStop("long", armed, armed)).toBe(true);
    // Beyond the threshold fires.
    expect(candleCrossesArmedStop("long", armed * 0.99, armed)).toBe(true);

    // ADA-specific: the actual observed close 0.1729654 is ABOVE 0.17133732
    // → policy would NOT have fired. Regression against the exact defect.
    expect(candleCrossesArmedStop("long", 0.1729654, armed)).toBe(false);
    expect(armed).toBeCloseTo(0.17133732, 8);
  });

  // Test 5
  it("pending / rejected final rung does not arm", () => {
    // Only 3 of 4 rungs filled — final rung is pending or rejected.
    expect(armLadderHardStop("long", 3, 4, ADA_FINAL_FILL).armed).toBe(false);
    // Zero fills.
    expect(armLadderHardStop("long", 0, 4, ADA_FINAL_FILL).armed).toBe(false);
    // Null fill price (no actual fill recorded yet).
    expect(armLadderHardStop("long", 4, 4, null).armed).toBe(false);
  });

  // Test 6 — safety overrides fire before final rung with precise reason codes.
  it("safety-override reason codes are distinct and never map to HARD STOP falsely", () => {
    expect(exitReasonLabel("kill_switch").label).toBe("KILL SWITCH");
    expect(exitReasonLabel("liquidation").label).toBe("LIQUIDATION GUARD");
    expect(exitReasonLabel("manual").label).toBe("MANUAL");
    expect(exitReasonLabel("account_guard").label).toBe("ACCOUNT GUARD");
    expect(exitReasonLabel("scout_bos").label).toBe("SCOUT INVALIDATION");
    // hard_stop stays HARD STOP; legacy "stop" continues to map to HARD STOP.
    expect(exitReasonLabel("hard_stop").label).toBe("HARD STOP");
    expect(exitReasonLabel("stop").label).toBe("HARD STOP");
    // Safety overrides are NEVER labelled as HARD STOP.
    for (const code of ["kill_switch", "liquidation", "manual", "account_guard"]) {
      expect(exitReasonLabel(code).label).not.toBe("HARD STOP");
    }
  });

  // Test 7 — non-ladder strategies (hunter/sniper) are not subject to the
  // ladder invariant. `isLadderPosition` returns false, so the engine's
  // non-ladder branch (which uses `open.stop_level`) remains authoritative.
  it("non-ladder strategy shapes are not treated as ladders", () => {
    expect(isLadderPosition({ strategy: "hunter", ladder_total_rungs: 1 })).toBe(false);
    expect(isLadderPosition({ strategy: "sniper", ladder_total_rungs: 4 })).toBe(false);
    expect(isLadderPosition({ strategy: "hunter", ladder_total_rungs: null })).toBe(false);
    // Ladder strategies with rungs > 1 ARE ladders.
    expect(isLadderPosition({ strategy: "accumulator", ladder_total_rungs: 4 })).toBe(true);
    expect(isLadderPosition({ strategy: "dca", ladder_total_rungs: 8 })).toBe(true);
    // Accumulator with a single rung is degenerate — not a ladder.
    expect(isLadderPosition({ strategy: "accumulator", ladder_total_rungs: 1 })).toBe(false);
    expect(LADDER_STRATEGIES.has("accumulator")).toBe(true);
    expect(LADDER_STRATEGIES.has("dca")).toBe(true);
    expect(LADDER_STRATEGIES.has("hunter")).toBe(false);
    expect(LADDER_STRATEGIES.has("sniper")).toBe(false);
  });

  // Test 8 — BTC/ETH 8-rung and ADA 4-rung each derive arming from their
  // own persisted final fill. No cross-contamination or hardcoded rung 8.
  it("BTC/ETH 8-rung and ADA 4-rung each arm from their own actual final fill", () => {
    const btc = armLadderHardStop("long", 8, 8, BTC_FINAL_FILL);
    const eth = armLadderHardStop("long", 8, 8, ETH_FINAL_FILL);
    const ada = armLadderHardStop("long", 4, 4, ADA_FINAL_FILL);

    expect(btc.armed).toBe(true);
    expect(btc.armedStopPrice!).toBeCloseTo(BTC_FINAL_FILL * 0.99, 8);
    expect(eth.armed).toBe(true);
    expect(eth.armedStopPrice!).toBeCloseTo(ETH_FINAL_FILL * 0.99, 8);
    expect(ada.armed).toBe(true);
    expect(ada.armedStopPrice!).toBeCloseTo(ADA_FINAL_FILL * 0.99, 12);

    // ADA arming is derived from ADA's own fill, not BTC's or ETH's.
    expect(ada.armedStopPrice).not.toBeCloseTo(BTC_FINAL_FILL * 0.99);
    expect(ada.armedStopPrice).not.toBeCloseTo(ETH_FINAL_FILL * 0.99);
    // ADA with a partial 4/8 fill (hypothetical) would NOT arm — no rung 8
    // hardcoding leaks in.
    expect(armLadderHardStop("long", 4, 8, ADA_FINAL_FILL).armed).toBe(false);
  });

  // Test 9 — arming payload is deterministic; two "concurrent" callers
  // producing the same input produce identical byte-for-byte payloads. The
  // RPC-level CAS on rung_count guarantees only one write commits; equal
  // payloads are the second-line guarantee (idempotent overwrite).
  it("arming payload is deterministic and idempotent under retry", () => {
    const nowMs = 1_700_000_000_000;
    const a = buildArmingPayload("long", ADA_FINAL_FILL, nowMs);
    const b = buildArmingPayload("long", ADA_FINAL_FILL, nowMs);
    expect(a).toEqual(b);
    expect(a.contract_version).toBe(LADDER_CONTRACT_VERSION);
    expect(a.reason).toBe("ladder_complete");
    expect(a.armed_stop_price).toBeCloseTo(ADA_FINAL_FILL * 0.99, 12);
    expect(a.final_rung_fill_price).toBe(ADA_FINAL_FILL);
  });

  // Test 10 — a 4-rung close labelled `hard_stop` groups to one parent row
  // with rung details and a HARD STOP label; the ADA-flavoured `stop`
  // legacy code also groups and labels HARD STOP so existing history stays
  // truthful.
  it("4-rung close groups to one parent row with a HARD STOP label", () => {
    const mk = (i: number, entry: number, exit: number, reason: string): RawPaperTrade => ({
      id: `t${i}`,
      position_id: "pos-1",
      wallet_key: "ADA-long",
      symbol: "ADA-USDT",
      direction: "long",
      entry_price: entry,
      exit_price: exit,
      exit_reason: reason,
      size_qty: 100,
      size_notional: entry * 100,
      margin: 15,
      pnl_gross: (exit - entry) * 100,
      pnl_net: (exit - entry) * 100 - 0.1,
      fees: 0.1,
      opened_at: "2026-07-21T06:50:00Z",
      closed_at: "2026-07-21T16:35:00Z",
    });
    const rungs = [
      mk(1, 0.1766, 0.1729654, "hard_stop"),
      mk(2, 0.175423, 0.1729654, "hard_stop"),
      mk(3, 0.174245, 0.1729654, "hard_stop"),
      mk(4, 0.173068, 0.1729654, "hard_stop"),
    ];
    const grouped = groupPaperTrades(rungs);
    expect(grouped).toHaveLength(1);
    const g = grouped[0];
    expect(g.rung_count).toBe(4);
    expect(g.exit_reason).toBe("hard_stop");
    expect(exitReasonLabel(g.exit_reason).label).toBe("HARD STOP");
    // Legacy "stop" code produced by earlier engine builds also folds into
    // the same parent-row + HARD STOP label so history remains truthful.
    const legacy = rungs.map((r) => ({ ...r, exit_reason: "stop" }));
    const groupedLegacy = groupPaperTrades(legacy);
    expect(groupedLegacy).toHaveLength(1);
    expect(exitReasonLabel(groupedLegacy[0].exit_reason).label).toBe("HARD STOP");
  });
});
