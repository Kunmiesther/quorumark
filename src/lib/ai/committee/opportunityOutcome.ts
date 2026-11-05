import { CLOSE, HIGH, LOW, TS, type Candle } from "@/lib/paper/signal";

export const OPPORTUNITY_METHOD_VERSION = "decision_close_directional_benchmark.v1";
export const OPPORTUNITY_WINDOWS = {
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
} as const;
export type OpportunityWindow = keyof typeof OPPORTUNITY_WINDOWS;
const BAR_MS = 15 * 60_000;

export interface DirectionalOutcome {
  status: "complete" | "insufficient_data";
  mfe_pct: number | null;
  mae_pct: number | null;
  net_pct: number | null;
  bars_used: number;
}

/**
 * Ex-post directional benchmark from the decision candle close. It assumes no
 * entry, fill, leverage, fee, or achievable P&L. The full window must close
 * before any outcome is returned; missing bars never become a success.
 */
export function evaluateMissedOpportunity(input: {
  direction: "long" | "short";
  referencePrice: number;
  decisionAtMs: number;
  nowMs: number;
  window: OpportunityWindow;
  candles: Candle[];
}): DirectionalOutcome | null {
  const windowMs = OPPORTUNITY_WINDOWS[input.window];
  const end = input.decisionAtMs + windowMs;
  if (input.nowMs < end) return null;
  const requiredBars = windowMs / BAR_MS;
  const bars = input.candles.filter(
    (bar) => bar[TS] >= input.decisionAtMs && bar[TS] + BAR_MS <= end,
  );
  const insufficient = (): DirectionalOutcome => ({
    status: "insufficient_data",
    mfe_pct: null,
    mae_pct: null,
    net_pct: null,
    bars_used: bars.length,
  });
  if (!Number.isFinite(input.referencePrice) || input.referencePrice <= 0) return insufficient();
  if (
    bars.length !== requiredBars ||
    bars[0]?.[TS] !== input.decisionAtMs ||
    bars[requiredBars - 1]?.[TS] + BAR_MS !== end ||
    bars.some((bar, index) => index > 0 && bar[TS] - bars[index - 1][TS] !== BAR_MS)
  ) return insufficient();

  const dir = input.direction === "long" ? 1 : -1;
  const p = input.referencePrice;
  const favorable = bars.map((bar) => dir === 1 ? (bar[HIGH] - p) / p : (p - bar[LOW]) / p);
  const adverse = bars.map((bar) => dir === 1 ? (p - bar[LOW]) / p : (bar[HIGH] - p) / p);
  return {
    status: "complete",
    mfe_pct: Math.max(0, ...favorable),
    mae_pct: Math.max(0, ...adverse),
    net_pct: dir * (bars[bars.length - 1][CLOSE] - p) / p,
    bars_used: bars.length,
  };
}
