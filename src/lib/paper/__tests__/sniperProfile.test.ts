/**
 * SNIPER PROFILE tests — shallow ladder + volatility-scaled early TP.
 *
 * Verifies the shared-JSON contract and the pure math helpers exposed by
 * src/lib/paper/sniperProfile.ts. Engine wiring (per-tick rewrite on rung
 * fill, promotion-vs-TP ordering) is asserted at the primitive level here
 * and structurally in the engine (see rung-fill block in engine.ts and the
 * pre-existing HTF promotion check that runs strictly BEFORE the per-lot
 * TP exit loop).
 */
import { describe, it, expect } from "vitest";
import {
  SNIPER_MAX_RUNGS,
  SNIPER_TP_ATR_MULT,
  SNIPER_TP_MIN_NET_PCT,
  sniperTpPrice,
} from "../sniperProfile";
import { buildLadder } from "../ladder";
import { planFormation } from "../adaptiveFormation";
import { FEE_RATE } from "../constants";

describe("sniperProfile: shared constants", () => {
  it("SNIPER_MAX_RUNGS = 2", () => {
    expect(SNIPER_MAX_RUNGS).toBe(2);
  });

  it("SNIPER_TP_ATR_MULT = 1.0", () => {
    expect(SNIPER_TP_ATR_MULT).toBe(1.0);
  });

  it("SNIPER_TP_MIN_NET_PCT clears round-trip taker fees with margin", () => {
    // Round-trip taker fees alone = 2 × FEE_RATE. Floor must exceed that
    // by a comfortable margin so a sniper TP fill is never a fee donation.
    expect(SNIPER_TP_MIN_NET_PCT).toBeGreaterThan(2 * FEE_RATE);
  });
});

describe("sniperProfile: sniperTpPrice math", () => {
  it("long TP = avgEntry + 1.0 × ATR when ATR dominates the floor", () => {
    // avgEntry=100, ATR=2 → atrDist=2, floor=100*0.0015=0.15 → dist=2
    expect(sniperTpPrice(100, "long", 2)).toBeCloseTo(102);
    expect(sniperTpPrice(100, "short", 2)).toBeCloseTo(98);
  });

  it("floor kicks in on tiny ATR (low-vol symbol) so TP still clears fees", () => {
    // avgEntry=100, ATR=0.05 → atrDist=0.05, floor=0.15 → dist=0.15
    const tpLong = sniperTpPrice(100, "long", 0.05);
    expect(tpLong).toBeCloseTo(100 + 100 * SNIPER_TP_MIN_NET_PCT);
    // Verify the resulting distance strictly exceeds round-trip taker fees.
    expect((tpLong - 100) / 100).toBeGreaterThan(2 * FEE_RATE);
  });

  it("floor kicks in when ATR is null / zero / undefined", () => {
    expect(sniperTpPrice(100, "long", null)).toBeCloseTo(100 + 100 * SNIPER_TP_MIN_NET_PCT);
    expect(sniperTpPrice(100, "long", 0)).toBeCloseTo(100 + 100 * SNIPER_TP_MIN_NET_PCT);
    expect(sniperTpPrice(100, "long", undefined)).toBeCloseTo(100 + 100 * SNIPER_TP_MIN_NET_PCT);
  });
});

describe("sniper ladder geometry (build-time)", () => {
  // Emulates the sniper override applied inside sizeLadder — 2 rungs at
  // sniper's fixed marginPerRung, with per-rung tp rewritten from the
  // avg-if-filled-through-that-rung. Keeps this test independent of the
  // full engine tick pipeline.
  const buildSniperRungs = (dir: "long" | "short", signalPx: number, atr: number, lev: number) => {
    const marginPerRung = 60 / SNIPER_MAX_RUNGS; // DCA_TOTAL_MARGIN_USD / 2
    const rungs = buildLadder(dir, signalPx, null, lev, marginPerRung, SNIPER_MAX_RUNGS);
    let cumN = 0, cumQ = 0;
    for (const r of rungs) {
      cumN += r.qty * r.price;
      cumQ += r.qty;
      r.tp = sniperTpPrice(cumN / cumQ, dir, atr);
    }
    return rungs;
  };

  it("builds exactly 2 rungs", () => {
    const rs = buildSniperRungs("long", 100, 1, 100);
    expect(rs.length).toBe(2);
  });

  it("rung1 tp = signalPx + ATR (long) when only rung1 filled", () => {
    const rs = buildSniperRungs("long", 100, 1, 100);
    // rung1's tp is computed from avg=rung1.price (which equals signalPx)
    expect(rs[0].tp).toBeCloseTo(100 + 1);
  });

  it("rung2 tp reflects avg-across-both-rungs (long: tp < rung1.tp)", () => {
    const rs = buildSniperRungs("long", 100, 1, 100);
    // avg after both < rung1 price (rung2 is deeper) → new TP < rung1.tp
    expect(rs[1].tp).toBeLessThan(rs[0].tp);
  });

  it("respects the min-net-pct floor when ATR is tiny", () => {
    const rs = buildSniperRungs("long", 100, 0.001, 100);
    // atr distance 0.001 < 100 × 0.0015 = 0.15 → floor wins
    expect(rs[0].tp - rs[0].price).toBeCloseTo(rs[0].price * SNIPER_TP_MIN_NET_PCT, 5);
  });
});

describe("other legs use the universal campaign rung count", () => {
  it("adaptive (ranging) plan for BTC @ 100× is five rungs", () => {
    const p = planFormation({ regime: "ranging" as never, leverage: 100, symbol: "BTC-USDT" });
    expect(p.mode).toBe("adaptive");
    expect(p.rungs).toBe(5);
  });

  it("adaptive plan rung count is leverage-derived, unaffected by sniper override", () => {
    const p = planFormation({ regime: "ranging" as never, leverage: 20, symbol: "SOL-USDT" });
    expect(p.mode).toBe("adaptive");
    expect(p.rungs).toBe(5);
  });
});
