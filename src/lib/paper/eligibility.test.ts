import { describe, expect, it } from "vitest";
import {
  ENTRY_FRESHNESS_CANDLES,
  accumulatorSignalKey,
  pickFreshUntradedAccumulatorEntry,
} from "./eligibility";
import type { RetestResult } from "./signal";

const STEP = 300_000;
const BASE = 1_700_000_000_000;

function tsAt(idx: number): number {
  return BASE + idx * STEP;
}

function mkRetest(idx: number, state: RetestResult["state"] = "confirmed"): RetestResult {
  return {
    state,
    break_event: {
      direction: "long",
      swing: { kind: "high", pivot_index: 0, pivot_ts: 0, level: 0, confirm_index: 0, confirm_ts: 0 },
      break_index: 0,
      break_ts: 0,
      break_close: 0,
      ema_at_break: 0,
      zone: { level: 0, tolerance: 0, upper: 0, lower: 0, atr: 0, tick: 0, atr_index: 0, assumption: "" },
    },
    retest_index: idx,
    retest_ts: tsAt(idx),
    reason: "",
  };
}

describe("pickFreshUntradedAccumulatorEntry", () => {
  const newestIdx = 197;
  const candlesTs = (i: number) => tsAt(i);

  it("returns a setup 2 candles old (within freshness window)", () => {
    const entries = [mkRetest(50), mkRetest(newestIdx - 2)]; // one old, one 2 back
    const picked = pickFreshUntradedAccumulatorEntry(
      entries, newestIdx, candlesTs, "SOL-USDT", "long", new Set(),
    );
    expect(picked).not.toBeNull();
    expect(picked!.retest.retest_index).toBe(newestIdx - 2);
    expect(picked!.signalKey).toBe(accumulatorSignalKey("SOL-USDT", "long", tsAt(newestIdx - 2)));
  });

  it("prefers the freshest un-traded setup over an older one", () => {
    const entries = [
      mkRetest(newestIdx - ENTRY_FRESHNESS_CANDLES),
      mkRetest(newestIdx - 1),
      mkRetest(newestIdx),
    ];
    const picked = pickFreshUntradedAccumulatorEntry(
      entries, newestIdx, candlesTs, "SOL-USDT", "long", new Set(),
    );
    expect(picked!.retest.retest_index).toBe(newestIdx);
  });

  it("skips a setup already traded (dedup by identity) and returns the next-most-recent", () => {
    const entries = [mkRetest(newestIdx - 2), mkRetest(newestIdx)];
    const tradedNewest = accumulatorSignalKey("SOL-USDT", "long", tsAt(newestIdx));
    const picked = pickFreshUntradedAccumulatorEntry(
      entries, newestIdx, candlesTs, "SOL-USDT", "long", new Set([tradedNewest]),
    );
    expect(picked).not.toBeNull();
    expect(picked!.retest.retest_index).toBe(newestIdx - 2);
  });

  it("returns null when every fresh setup is already traded", () => {
    const entries = [mkRetest(newestIdx - 2), mkRetest(newestIdx)];
    const traded = new Set([
      accumulatorSignalKey("SOL-USDT", "long", tsAt(newestIdx)),
      accumulatorSignalKey("SOL-USDT", "long", tsAt(newestIdx - 2)),
    ]);
    const picked = pickFreshUntradedAccumulatorEntry(
      entries, newestIdx, candlesTs, "SOL-USDT", "long", traded,
    );
    expect(picked).toBeNull();
  });

  it("ignores setups outside the freshness window", () => {
    const stale = mkRetest(newestIdx - ENTRY_FRESHNESS_CANDLES - 1);
    const picked = pickFreshUntradedAccumulatorEntry(
      [stale], newestIdx, candlesTs, "SOL-USDT", "long", new Set(),
    );
    expect(picked).toBeNull();
  });

  it("ignores non-confirmed states", () => {
    const entries = [mkRetest(newestIdx, "pending"), mkRetest(newestIdx - 1, "expired_breach")];
    const picked = pickFreshUntradedAccumulatorEntry(
      entries, newestIdx, candlesTs, "SOL-USDT", "long", new Set(),
    );
    expect(picked).toBeNull();
  });
});
