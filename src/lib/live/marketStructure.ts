import { CLOSE, HIGH, LOW, TS, VOLUME, type Candle } from "@/lib/paper/signal";

export interface ConfirmedSwing {
  price: number;
  confirmed_at_ms: number;
}

/** Evidence for an AI review, not an automatic reversal verdict. */
export interface MarketStructureEvidence {
  bars: number;
  last_close: number;
  atr_14: number | null;
  confirmed_swing_high: ConfirmedSwing | null;
  confirmed_swing_low: ConfirmedSwing | null;
  close_above_swing_high_atr: number | null;
  close_below_swing_low_atr: number | null;
  last_volume_vs_prior_20: number | null;
  /** A wick through an established level that closes back inside it. */
  sweep_and_reclaim_high: boolean;
  sweep_and_reclaim_low: boolean;
  /** Two completed closes beyond the established level, not a one-bar wick. */
  confirmed_break_above: boolean;
  confirmed_break_below: boolean;
  /** A one-close break that was rejected by the next completed candle. */
  rejected_breakout_high: boolean;
  rejected_breakdown_low: boolean;
}

export type PositionStructureRead = {
  /** Evidence classification for review only; never an order instruction. */
  state: "continuation" | "pullback" | "fakeout" | "reversal_risk" | "unclear";
  posture: "press" | "patient" | "defensive";
  reasons: string[];
};

/**
 * Separate a one-bar sweep/pullback from a multi-frame structure failure.
 * `press` means an intact thesis may be held for review, not that size or
 * leverage may be increased. All states remain advisory evidence.
 */
export function positionStructureRead(input: {
  direction: "long" | "short";
  fiveMinute: MarketStructureEvidence | null;
  fifteenMinute: MarketStructureEvidence | null;
  hourlyTrend: "up" | "down" | "flat" | null;
  fourHourTrend: "up" | "down" | "flat" | null;
}): PositionStructureRead {
  const { direction, fiveMinute: fast, fifteenMinute: medium } = input;
  const adverseBreak = (e: MarketStructureEvidence | null) =>
    direction === "long" ? e?.confirmed_break_below === true : e?.confirmed_break_above === true;
  const adverseFakeout = (e: MarketStructureEvidence | null) =>
    direction === "long"
      ? e?.sweep_and_reclaim_low === true || e?.rejected_breakdown_low === true
      : e?.sweep_and_reclaim_high === true || e?.rejected_breakout_high === true;
  const adverseSingleClose = (e: MarketStructureEvidence | null) =>
    direction === "long"
      ? (e?.close_below_swing_low_atr ?? 0) > 0
      : (e?.close_above_swing_high_atr ?? 0) > 0;
  const oppositeTrend = direction === "long" ? "down" : "up";
  const alignedTrend = direction === "long" ? "up" : "down";

  if (adverseBreak(medium) && (adverseBreak(fast) || input.hourlyTrend === oppositeTrend)) {
    return {
      state: "reversal_risk",
      posture: "defensive",
      reasons: ["15m_confirmed_structure_break", "5m_break_or_opposing_1h_trend"],
    };
  }
  if (adverseFakeout(fast) || adverseFakeout(medium)) {
    return {
      state: "fakeout",
      posture: "patient",
      reasons: ["adverse_sweep_reclaimed_or_break_rejected"],
    };
  }
  if (adverseSingleClose(fast) || adverseBreak(fast)) {
    return {
      state: "pullback",
      posture: "patient",
      reasons: ["short_timeframe_adverse_move_without_confirmed_reversal"],
    };
  }
  if (
    input.hourlyTrend === alignedTrend &&
    input.fourHourTrend === alignedTrend &&
    !adverseBreak(medium)
  ) {
    return {
      state: "continuation",
      posture: "press",
      reasons: ["1h_4h_trend_aligned", "no_confirmed_15m_adverse_break"],
    };
  }
  return { state: "unclear", posture: "patient", reasons: ["insufficient_or_mixed_structure"] };
}

function finite(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(5)) : null;
}

export function marketStructureEvidence(candles: Candle[]): MarketStructureEvidence | null {
  if (!candles.length) return null;
  const bars = candles.slice(-80);
  const last = bars[bars.length - 1];
  const ranges = bars.map((bar, index) => {
    const previousClose = index > 0 ? bars[index - 1][CLOSE] : bar[CLOSE];
    return Math.max(
      bar[HIGH] - bar[LOW],
      Math.abs(bar[HIGH] - previousClose),
      Math.abs(bar[LOW] - previousClose),
    );
  });
  const atr =
    ranges.length >= 14 ? ranges.slice(-14).reduce((sum, range) => sum + range, 0) / 14 : null;

  let high: ConfirmedSwing | null = null;
  let low: ConfirmedSwing | null = null;
  // Two completed candles on either side are required to confirm a pivot.
  // The current bar can never be promoted to a confirmed swing.
  for (let index = 2; index < bars.length - 2; index++) {
    const bar = bars[index];
    if (
      bar[HIGH] > bars[index - 1][HIGH] &&
      bar[HIGH] > bars[index - 2][HIGH] &&
      bar[HIGH] >= bars[index + 1][HIGH] &&
      bar[HIGH] >= bars[index + 2][HIGH]
    )
      high = { price: bar[HIGH], confirmed_at_ms: bars[index + 2][TS] };
    if (
      bar[LOW] < bars[index - 1][LOW] &&
      bar[LOW] < bars[index - 2][LOW] &&
      bar[LOW] <= bars[index + 1][LOW] &&
      bar[LOW] <= bars[index + 2][LOW]
    )
      low = { price: bar[LOW], confirmed_at_ms: bars[index + 2][TS] };
  }

  const priorVolumes = bars
    .slice(-21, -1)
    .map((bar) => bar[VOLUME])
    .filter((volume) => volume > 0);
  const priorAverage =
    priorVolumes.length >= 10
      ? priorVolumes.reduce((sum, volume) => sum + volume, 0) / priorVolumes.length
      : null;
  const volumeRatio = priorAverage && last[VOLUME] > 0 ? last[VOLUME] / priorAverage : null;
  const previous = bars.length > 1 ? bars[bars.length - 2] : null;
  // A pivot confirmed by the current candle was not an established level
  // before this candle. Never use it to label the same candle a fakeout.
  const establishedHigh = previous && high && high.confirmed_at_ms <= previous[TS] ? high.price : null;
  const establishedLow = previous && low && low.confirmed_at_ms <= previous[TS] ? low.price : null;
  const buffer = atr && atr > 0 ? atr * 0.15 : 0;
  const sweepBuffer = atr && atr > 0 ? atr * 0.1 : 0;
  const confirmedBreakAbove =
    establishedHigh !== null &&
    previous !== null &&
    previous[CLOSE] > establishedHigh + buffer &&
    last[CLOSE] > establishedHigh + buffer;
  const confirmedBreakBelow =
    establishedLow !== null &&
    previous !== null &&
    previous[CLOSE] < establishedLow - buffer &&
    last[CLOSE] < establishedLow - buffer;

  return {
    bars: bars.length,
    last_close: last[CLOSE],
    atr_14: atr === null ? null : finite(atr),
    confirmed_swing_high: high,
    confirmed_swing_low: low,
    close_above_swing_high_atr: atr && high ? finite((last[CLOSE] - high.price) / atr) : null,
    close_below_swing_low_atr: atr && low ? finite((low.price - last[CLOSE]) / atr) : null,
    last_volume_vs_prior_20: volumeRatio === null ? null : finite(volumeRatio),
    sweep_and_reclaim_high:
      establishedHigh !== null && last[HIGH] > establishedHigh + sweepBuffer && last[CLOSE] < establishedHigh,
    sweep_and_reclaim_low:
      establishedLow !== null && last[LOW] < establishedLow - sweepBuffer && last[CLOSE] > establishedLow,
    confirmed_break_above: confirmedBreakAbove,
    confirmed_break_below: confirmedBreakBelow,
    rejected_breakout_high:
      establishedHigh !== null &&
      previous !== null &&
      previous[CLOSE] > establishedHigh + buffer &&
      last[CLOSE] < establishedHigh,
    rejected_breakdown_low:
      establishedLow !== null &&
      previous !== null &&
      previous[CLOSE] < establishedLow - buffer &&
      last[CLOSE] > establishedLow,
  };
}
