/**
 * The evidence snapshot handed to the three model seats must state the whole
 * timeframe hierarchy, including the frames that were NOT available.
 *
 * This is a truthfulness test, not a formatting one. The earlier snapshot
 * carried only 5m fields, which reads to a model — and to a human auditing
 * the ledger — as "5m was the only frame considered". Omission and
 * unavailability are different claims, and only one of them is true here:
 * the paper feed is ~16h of 5m bars, so 15m/1h/4h are derivable and
 * daily/weekly/monthly are not.
 */
import { describe, it, expect } from "vitest";
import { buildPaperEvidence, type PaperCandidateInput } from "../aiOrchestration.server";

const base: PaperCandidateInput = {
  key: "BTC-USDT:long:1",
  symbol: "BTC-USDT",
  direction: "long",
  leg: "accumulator",
  entryCandleTs: 1_700_000_100_000,
  fillPx: 64_000,
  stopLevel: 63_500,
  tpLevel: 65_000,
  zoneLower: 63_800,
  zoneUpper: 64_200,
  margin: 60,
  notional: 6000,
  leverage: 100,
  regime: "trend",
  trendState: "up",
  trendSlopePct: 0.4,
  movementScore: 1.2,
  deterministicApproved: true,
};

const tf = (c: PaperCandidateInput) =>
  buildPaperEvidence(c)["timeframes"] as Record<string, unknown>;

describe("paper evidence timeframe hierarchy", () => {
  it("names each frame's role so 5m is not implied to be the only input", () => {
    const t = tf(base);
    expect(t["entry_tf"]).toBe("15m");
    expect(t["setup_tf"]).toBe("1h/4h");
    expect(t["regime_tf"]).toBe("15m + 1d/1w/1M environment");
    expect(t["environment_tf"]).toBe("1d/1w/1M");
  });

  // OWNER CORRECTION #6: D/W/M are now fetched natively from the venue. The
  // permanent "feed_window_shorter_than_1d" placeholder is gone — the block is
  // only unavailable when the fetch genuinely produced nothing.
  it("reports daily/weekly/monthly as unavailable with a reason when not fetched", () => {
    const t = tf(base);
    expect(t["environment_tf_available"]).toBe(false);
    expect(t["environment_tf_unavailable_reason"]).toBe("environment_frames_not_fetched");
    expect(t["environment_tf_frames"]).toBeNull();
  });

  it("carries real 1d/1w/1M summaries when the venue frames were fetched", () => {
    const t = tf({
      ...base,
      env: {
        available: true,
        unavailable_reason: null,
        fetched_at_ms: 1_770_000_000_000,
        frames: {
          "1d": {
            last_closed_ms: 1_769_990_400_000,
            open: 100, high: 130, low: 95, close: 125,
            change_pct: 13.6364, direction: "up", range_position: 0.857, bars: 30,
          },
        },
      },
    });
    expect(t["environment_tf_available"]).toBe(true);
    expect(t["environment_tf_unavailable_reason"]).toBeNull();
    const frames = t["environment_tf_frames"] as Record<string, { direction: string }>;
    expect(frames["1d"]!.direction).toBe("up");
  });


  it("carries the real HTF close timestamps when the engine folded them", () => {
    const t = tf({
      ...base,
      htf: {
        bos1h: "bullish_bos",
        bos4h: "none",
        lastClosed4hMs: 1_699_986_000_000,
        lastClosed1hMs: 1_699_999_200_000,
        lastClosed15mMs: 1_700_000_100_000,
      },
    });
    expect(t["setup_tf_close_ms"]).toBe(1_699_999_200_000);
    expect(t["regime_tf_1h_close_ms"]).toBe(1_699_999_200_000);
    expect(t["regime_tf_4h_close_ms"]).toBe(1_699_986_000_000);
    expect(t["bos_1h"]).toBe("bullish_bos");
    expect(t["bos_4h"]).toBe("none");
  });

  it("reports null — not a guess — for frames the caller did not fold", () => {
    const t = tf(base);
    for (const key of ["setup_tf_close_ms", "regime_tf_1h_close_ms", "regime_tf_4h_close_ms", "bos_1h", "bos_4h"]) {
      expect(t[key], key).toBeNull();
    }
  });

  it("changes the evidence schema version, so v1 hashes are not reused for v2 content", () => {
    // The evidence hash is the trace's identity. Adding fields under the old
    // version would let a v1 row and a v2 row disagree about what the models
    // were actually shown.
    expect(buildPaperEvidence(base)["schema"]).toBe("paper_candidate.v2");
  });

  it("distinguishes two candidates that differ only in HTF context", () => {
    const withBos = buildPaperEvidence({
      ...base,
      htf: { bos1h: "bearish_bos", bos4h: null, lastClosed4hMs: null, lastClosed1hMs: null, lastClosed15mMs: null },
    });
    expect(JSON.stringify(withBos)).not.toBe(JSON.stringify(buildPaperEvidence(base)));
  });
});
