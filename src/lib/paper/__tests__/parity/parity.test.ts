/**
 * Parity tests — TypeScript side.
 *
 * Runs the paper-engine implementations against fixtures shared with the
 * Python live-worker suite (`tests/parity/*.py`). Every fixture assertion
 * here must have a mirror in the Python suite (or an explicit `pytest.skip`
 * tied to a DEBT-XX in docs/MAINNET_PARITY.md).
 *
 * IMPORTANT: no strategy math lives in this file — we only assert that the
 * shipped detectors agree with the fixture-encoded expected verdict.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Candle } from "../../signal";
import { evaluate } from "../../signal";
import { classifyRegime } from "../../regime";
import { legForRegime } from "../../routing";
import { evaluateEntryAuthorization } from "../../entryGuard";
import { detectHtfBos } from "../../htfBos";
import { shouldTriggerMaxLoss } from "../../constants";
import {
  ladderSpanPct,
  dcaRungsForLeverage,
  dcaMarginPerRungForLeverage,
  DCA_TOTAL_MARGIN_USD,
  DCA_RUNG_TP_PCT,
  HARD_STOP_BEYOND_LAST_RUNG_PCT,
} from "../../ladder";

const FIXTURES = resolve(__dirname, "../../../../../tests/fixtures/parity");

function load(name: string): any {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), "utf-8"));
}

describe("parity: regime + routing", () => {
  it("regime_trend_btc → trend / accumulator", () => {
    const f = load("regime_trend_btc.json");
    const regime = classifyRegime(f.candles as Candle[]).regime;
    expect(regime).toBe(f.expected.regime);
    expect(legForRegime(regime)).toBe(f.expected.leg);
  });

  it("regime_neutral_eth → neutral / sniper", () => {
    const f = load("regime_neutral_eth.json");
    const regime = classifyRegime(f.candles as Candle[]).regime;
    expect(regime).toBe(f.expected.regime);
    expect(legForRegime(regime)).toBe(f.expected.leg);
  });

  it("regime_highvol_sol → high_vol / hunter", () => {
    const f = load("regime_highvol_sol.json");
    const regime = classifyRegime(f.candles as Candle[]).regime;
    expect(regime).toBe(f.expected.regime);
    expect(legForRegime(regime)).toBe(f.expected.leg);
  });
});

describe("parity: entry guard", () => {
  it("entry_guard_wait_opposing → blocked", () => {
    const f = load("entry_guard_wait_opposing.json");
    const r = evaluateEntryAuthorization({
      regime: f.regime,
      leverage: f.leverage,
      symbol: f.symbol,
    });
    expect(r.authorized).toBe(f.expected.authorized);
    expect(r.blockCode).toBe(f.expected.block_code);
  });
});

describe("parity: BOS detection", () => {
  it("bos_5m_bearish → accumulator.evaluate finds a bearish break", () => {
    const f = load("bos_5m_bearish.json");
    const r = evaluate(f.candles as Candle[], "short", f.tick);
    const bearishBreaks = r.breaks.filter((b) => b.direction === "short");
    expect(bearishBreaks.length).toBeGreaterThan(0);
    // level should be the pivot low (~95); allow small tolerance for zone build
    const anyMatch = bearishBreaks.some(
      (b) => Math.abs(b.swing.level - f.expected.break_level) < 0.5,
    );
    expect(anyMatch).toBe(true);
  });

  it("bos_1h_bullish → htfBos.detectHtfBos returns bullish state", () => {
    const f = load("bos_1h_bullish.json");
    const r = detectHtfBos(f.candles as Candle[], f.tick);
    expect(r.state).toBe(f.expected.state);
    if (f.expected.broken_level != null && r.brokenLevel != null) {
      expect(Math.abs(r.brokenLevel - f.expected.broken_level)).toBeLessThan(0.5);
    }
  });
});

describe("parity: ladder policy (shared JSON)", () => {
  it("ladder_5rung_btc_100x → derives from shared constants", () => {
    const f = load("ladder_5rung_btc_100x.json");
    const rungs = dcaRungsForLeverage(f.leverage);
    const perRung = dcaMarginPerRungForLeverage(f.leverage);
    const span = ladderSpanPct(f.leverage);
    expect(DCA_TOTAL_MARGIN_USD).toBe(f.expected.total_margin_usd);
    expect(rungs).toBe(f.expected.rungs);
    expect(perRung).toBeCloseTo(f.expected.per_rung_margin_usd, 6);
    expect(DCA_RUNG_TP_PCT).toBe(f.expected.rung_tp_pct);
    expect(span).toBeCloseTo(f.expected.span_pct, 6);
    expect(HARD_STOP_BEYOND_LAST_RUNG_PCT).toBe(
      f.expected.hard_stop_beyond_last_rung_pct,
    );
  });
});

describe("parity: max-loss cap", () => {
  it("max_loss_trigger → shouldTriggerMaxLoss = true", () => {
    const f = load("max_loss_trigger.json");
    expect(
      shouldTriggerMaxLoss(f.margin_usd, f.unrealized_worst_usd),
    ).toBe(f.expected.triggered);
  });
});

// ─────────── SWEEP (H2 mid-weighted pyramid) ───────────
// The 1h momentum-hold evaluator (sweepMomentum.ts) was removed in the H2
// lockdown. Momentum fixtures (sweep_1h_momentum_{hold,flip}.json) deleted.
// Sweep detection stays covered by sweep_1h_{long,short}_rejection.json below,
// and H2 sizing/exit math has its own parity fixtures
// (sweep_h2_ladder_{long,short}.json) covered in sweepH2.parity.test.ts.
import { detectSweep } from "../../sweep";

describe("parity: sweep 1h entry", () => {
  const cases = [
    ["sweep_1h_long_rejection.json", "long", "rejection"],
    ["sweep_1h_short_rejection.json", "short", "rejection"],
  ] as const;
  for (const [name, dir, mode] of cases) {
    it(`${name} → ${dir} ${mode}`, () => {
      const f = load(name);
      const candles = f.candles_1h as Candle[];
      const n = candles.length;
      const atr: (number | null)[] = new Array(n).fill(null);
      const period = 14;
      if (n >= period + 1) {
        const trs: number[] = [];
        for (let i = 1; i < n; i++) {
          const h = candles[i][2], l = candles[i][3], pc = candles[i - 1][4];
          trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
        }
        let avg = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
        atr[period] = avg;
        for (let i = period + 1; i < n; i++) {
          avg = (avg * (period - 1) + trs[i - 1]) / period;
          atr[i] = avg;
        }
      }
      const r = detectSweep({
        candles, atr, htfBosState: f.htf_bos_state, tick: f.tick,
      });
      expect(r).not.toBeNull();
      expect(r!.direction).toBe(f.expected.direction);
      expect(r!.mode).toBe(f.expected.mode);
      expect(Math.abs(r!.entry - f.expected.entry)).toBeLessThan(1e-9);
      expect(Math.abs(r!.stop - f.expected.stop)).toBeLessThan(1e-9);
    });
  }
});
