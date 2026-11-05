/**
 * Market context — PURE. Computes fleet breadth, BTC/ETH MTF bias, and
 * per-symbol rolling correlation to BTC from already-fetched closed candles.
 *
 * Confidence adjustment is CAPPED at ±0.10 with deterministic reason codes.
 * Context cannot override stale/missing required H4/D — the caller must gate
 * on `htf_valid` before applying context.
 *
 * External macro (funding, OI, liquidations, order book, dominance) is
 * explicitly NOT_CONNECTED and NEVER contributes to score.
 *
 * READ-ONLY MODULE. See `scout-no-execution-imports.test.ts`.
 */

import { CLOSE, type Candle } from "@/lib/paper/signal";
import type { CompactEvidence } from "./evidence";
import type { Bias } from "./types";

export const CONTEXT_MAX_ADJUST = 0.10;
export const MIN_CORRELATION_BARS = 40;

export const NOT_CONNECTED = {
  funding: "NOT_CONNECTED" as const,
  open_interest: "NOT_CONNECTED" as const,
  liquidations: "NOT_CONNECTED" as const,
  order_book: "NOT_CONNECTED" as const,
  dominance: "NOT_CONNECTED" as const,
};

export type ContextReasonCode =
  | "context_btc_bull"
  | "context_btc_bear"
  | "context_eth_bull"
  | "context_eth_bear"
  | "context_fleet_bull_majority"
  | "context_fleet_bear_majority"
  | "context_fleet_balanced"
  | "context_no_signal_majority"
  | "context_high_btc_corr"
  | "context_low_btc_corr"
  | "context_insufficient_correlation_history"
  | "context_adjust_capped";

export interface FleetBreadth {
  bull_pct: number;
  bear_pct: number;
  balanced_pct: number;
  no_signal_pct: number;
  n: number;
}

export interface AnchorBias {
  btc: Bias;
  eth: Bias;
}

export interface ContextInput {
  symbol: string;
  proposedBias: Bias;
  proposedScore: number; // signed weighted score [-1, +1]
  fleet: FleetBreadth;
  anchors: AnchorBias;
  /** Per-symbol closed candles aligned with BTC's. If <MIN_CORRELATION_BARS, correlation is skipped. */
  symbolCloses: number[];
  btcCloses: number[];
}

export interface ContextResult {
  adjust: number; // clamped ±CONTEXT_MAX_ADJUST
  reasons: ContextReasonCode[];
  correlation: number | null;
  breadth: FleetBreadth;
  anchors: AnchorBias;
  not_connected: typeof NOT_CONNECTED;
}

function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < MIN_CORRELATION_BARS) return null;
  const aa = a.slice(-n);
  const bb = b.slice(-n);
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += aa[i]; sb += bb[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = aa[i] - ma;
    const xb = bb[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const denom = Math.sqrt(da * db);
  if (denom === 0) return null;
  const r = num / denom;
  return Math.max(-1, Math.min(1, r));
}

export function returns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const p = closes[i - 1];
    if (p > 0) out.push((closes[i] - p) / p);
  }
  return out;
}

export function computeBreadth(biases: Bias[]): FleetBreadth {
  const n = biases.length;
  if (n === 0) return { bull_pct: 0, bear_pct: 0, balanced_pct: 0, no_signal_pct: 0, n: 0 };
  let bull = 0, bear = 0, bal = 0, no = 0;
  for (const b of biases) {
    if (b === "long-priority") bull++;
    else if (b === "short-priority") bear++;
    else if (b === "balanced") bal++;
    else no++;
  }
  return {
    bull_pct: bull / n,
    bear_pct: bear / n,
    balanced_pct: bal / n,
    no_signal_pct: no / n,
    n,
  };
}

/**
 * Compute a signed context adjustment capped at ±CONTEXT_MAX_ADJUST.
 * Deterministic; never fabricates macro data.
 */
export function computeContext(input: ContextInput): ContextResult {
  const reasons: ContextReasonCode[] = [];
  let raw = 0;

  // Anchor bias: BTC and ETH each nudge ±0.05 in trend direction.
  if (input.anchors.btc === "long-priority") { raw += 0.05; reasons.push("context_btc_bull"); }
  else if (input.anchors.btc === "short-priority") { raw -= 0.05; reasons.push("context_btc_bear"); }
  if (input.anchors.eth === "long-priority") { raw += 0.03; reasons.push("context_eth_bull"); }
  else if (input.anchors.eth === "short-priority") { raw -= 0.03; reasons.push("context_eth_bear"); }

  // Breadth: majority-agree nudge.
  const b = input.fleet;
  if (b.n >= 3) {
    if (b.bull_pct >= 0.6) { raw += 0.03; reasons.push("context_fleet_bull_majority"); }
    else if (b.bear_pct >= 0.6) { raw -= 0.03; reasons.push("context_fleet_bear_majority"); }
    else if (b.balanced_pct >= 0.5) reasons.push("context_fleet_balanced");
    if (b.no_signal_pct >= 0.5) reasons.push("context_no_signal_majority");
  }

  // Correlation to BTC (returns-based). Only if enough aligned history.
  const rets = returns(input.symbolCloses);
  const btcRets = returns(input.btcCloses);
  const corr = pearson(rets, btcRets);
  if (corr == null) {
    reasons.push("context_insufficient_correlation_history");
  } else if (Math.abs(corr) >= 0.7) {
    reasons.push("context_high_btc_corr");
    // Amplify BTC-aligned bias only slightly.
    if (input.anchors.btc === "long-priority" && input.proposedScore > 0) raw += 0.02;
    if (input.anchors.btc === "short-priority" && input.proposedScore < 0) raw -= 0.02;
  } else if (Math.abs(corr) <= 0.2) {
    reasons.push("context_low_btc_corr");
  }

  // If proposed bias contradicts BTC strongly, dampen instead of amplify.
  if (input.proposedBias === "long-priority" && input.anchors.btc === "short-priority") raw -= 0.02;
  if (input.proposedBias === "short-priority" && input.anchors.btc === "long-priority") raw += 0.02;

  // Cap.
  const capped = Math.max(-CONTEXT_MAX_ADJUST, Math.min(CONTEXT_MAX_ADJUST, raw));
  if (capped !== raw) reasons.push("context_adjust_capped");

  return {
    adjust: capped,
    reasons,
    correlation: corr,
    breadth: input.fleet,
    anchors: input.anchors,
    not_connected: NOT_CONNECTED,
  };
}

/** Convenience: extract closed-candle closes from a Candle series. */
export function closesOf(candles: Candle[]): number[] {
  return candles.map((c) => c[CLOSE]);
}

/** Convenience: derive anchor bias from any pre-computed weighted score/dead-zone bias. */
export function anchorBiasFrom(evidence: CompactEvidence | null): Bias {
  if (!evidence) return "no-signal";
  if (evidence.direction === "long" && evidence.score > 0.20) return "long-priority";
  if (evidence.direction === "short" && evidence.score < -0.20) return "short-priority";
  if (evidence.direction === "none") return "no-signal";
  return "balanced";
}
