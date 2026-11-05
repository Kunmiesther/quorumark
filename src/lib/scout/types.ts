/**
 * Scout MTF control-plane public types.
 *
 * READ-ONLY MODULE. Nothing in `src/lib/scout/**` may import from the paper
 * engine, Onyx decide, execution broker, signer, or the service-role client.
 * An ESLint boundary and a vitest static-analysis test enforce this.
 */

export type Timeframe = "M" | "W" | "D" | "H4" | "H1" | "M15" | "M5";

export const TIMEFRAMES: readonly Timeframe[] = ["M", "W", "D", "H4", "H1", "M15", "M5"] as const;

export const TIMEFRAME_ROLE: Record<Timeframe, string> = {
  M: "macro",
  W: "environment",
  D: "bias",
  H4: "regime",
  H1: "formation",
  M15: "setup",
  M5: "timing",
};

export const TIMEFRAME_LABEL: Record<Timeframe, string> = {
  M: "1M",
  W: "1W",
  D: "1D",
  H4: "4h",
  H1: "1h",
  M15: "15m",
  M5: "5m",
};

/** Milliseconds per closed candle for each role. */
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  M: 30 * 24 * 60 * 60 * 1000, // approximate — actual monthly is calendar-aligned
  W: 7 * 24 * 60 * 60 * 1000,
  D: 24 * 60 * 60 * 1000,
  H4: 4 * 60 * 60 * 1000,
  H1: 60 * 60 * 1000,
  M15: 15 * 60 * 1000,
  M5: 5 * 60 * 1000,
};

/**
 * Weights for the multi-timeframe consensus. Higher-timeframe context
 * (M+W+D+H4 = 0.55) dominates; 5m alone (0.10) cannot flip macro bias.
 */
export const TIMEFRAME_WEIGHT: Record<Timeframe, number> = {
  M: 0.05,
  W: 0.10,
  D: 0.15,
  H4: 0.25,
  H1: 0.20,
  M15: 0.15,
  M5: 0.10,
};

/** Cache TTL in ms per timeframe — refresh cadence for the batched market cache. */
export const TIMEFRAME_TTL_MS: Record<Timeframe, number> = {
  M: 24 * 60 * 60 * 1000, // 24h
  W: 12 * 60 * 60 * 1000, // 12h
  D: 2 * 60 * 60 * 1000,  // 2h
  H4: 20 * 60 * 1000,     // 20m
  H1: 5 * 60 * 1000,      // 5m
  M15: 90 * 1000,         // 90s
  M5: 30 * 1000,          // 30s
};

/**
 * "Stale" threshold: how many closed-candle intervals may pass before we mark
 * data stale.
 *
 * INVARIANT: the newest CLOSED candle for a timeframe must never be marked
 * stale while the exchange is healthy. `keepClosed` drops the currently-
 * forming bucket, so the freshest possible closed bar is `interval` old at
 * the moment of close and grows to just under `2 × interval` right before
 * the next close. A multiplier ≤ 2.0 makes D/W/M spontaneously turn "stale"
 * partway through every bucket even when ingestion is perfect (the observed
 * cause of the Scout HEALTH=DEGRADED / "higher-timeframe context missing or
 * stale" symptom).
 *
 * We use 2.5 for D/W/M to allow one full bucket of grace plus 50% slack for
 * exchange lag; intraday TFs keep their existing multi-bucket tolerance to
 * absorb transient fetch gaps.
 */
export const TIMEFRAME_STALE_MULT: Record<Timeframe, number> = {
  M: 2.5,
  W: 2.5,
  D: 2.5,
  H4: 2.5,
  H1: 3,
  M15: 4,
  M5: 4,
};

export type TfState = "bullish" | "bearish" | "neutral" | "mixed" | "unavailable";

export type ReasonCode =
  | "ema_stack_up"
  | "ema_stack_down"
  | "slope_flat"
  | "range_compression"
  | "bos_up"
  | "bos_down"
  | "atr_spike"
  | "insufficient_history"
  | "stale_data"
  | "aggregation_gap";

export interface TimeframeState {
  tf: Timeframe;
  state: TfState;
  /** Signed -1..+1 evidence score for this timeframe. */
  score: number;
  lastClosedTs: number | null;
  ageMs: number | null;
  stale: boolean;
  reasons: ReasonCode[];
}

export type Bias = "long-priority" | "short-priority" | "balanced" | "no-signal";
export type Readiness = "armed" | "watching" | "no-signal";

export interface ConsensusResult {
  bias: Bias;
  readiness: Readiness;
  /** Signed weighted sum -1..+1. */
  weightedScore: number;
  /** 0..1. */
  confidence: number;
  /** 0..1 — higher means more disagreement across timeframes. */
  conflict: number;
  /** Fraction of timeframes with usable data. */
  availability: number;
}

export interface ScoutSymbolReport {
  symbol: string;
  base: string;
  anchor: boolean;
  paperEnabled: boolean;
  timeframes: TimeframeState[];
  consensus: ConsensusResult;
  expiresAt: number;
  /** True when higher-TF data required for a real bias was missing/stale. */
  degraded: boolean;
  error: string | null;
  /**
   * Scout intelligence-plane market regime (P1) — one of seven categories
   * plus `unknown`. Populated deterministically from consensus + signal state
   * + evidence by `classifyMarketRegime`. Consumed by ONYX to select
   * FORMATION (precision / staged / adaptive-DCA / wait / hedge-evaluation).
   * Persistence lands with a follow-up migration; this field is always
   * emitted in the in-memory report.
   */
  marketRegime: import("./regime").MarketRegime;
  regimeEvidence: import("./regime").RegimeEvidence;
}


export type ScoutHealth = "healthy" | "degraded" | "stale" | "offline";

export interface ScoutFleetReport {
  scanId: string | null;
  startedAt: number;
  finishedAt: number;
  symbols: ScoutSymbolReport[];
  health: ScoutHealth;
  nextRefreshAt: number;
}
