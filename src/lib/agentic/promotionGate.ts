// Promotion gate for a FUTURE owner-only agentic LIVE path.
//
// STATUS: IMPLEMENTED AND DISABLED. Nothing in this module enables live
// execution. It evaluates whether measured paper performance WOULD satisfy the
// owner's configured thresholds, and reports the gap. Flipping the gate is an
// explicit owner action against `public.agentic_promotion_gate`, guarded by a
// database trigger that rejects any non-owner row and any row without
// `owner_approved`.
//
// THRESHOLD HONESTY: the defaults shipped in the migration are conservative
// placeholders, NOT validated success criteria. `thresholdsAreOwnerSet` marks
// an evaluation as provisional until the owner has reviewed them, so the UI can
// never present a default-driven "eligible" as a real qualification.

export interface PromotionThresholds {
  minSampleSize: number;
  minNetPnl: number;
  minExpectancy: number;
  minProfitFactor: number;
  maxDrawdownPct: number;
  maxDegradedRatePct: number;
  requireZeroMissingTrace: boolean;
  requireZeroRiskViolations: boolean;
}

export interface PromotionMetrics {
  sampleSize: number;
  netPnl: number;
  expectancy: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  degradedRatePct: number;
  missingTraceViolations: number;
  riskRuleViolations: number;
  /** Executions whose trace/risk chain is intact, as a share of executions. */
  executionIntegrityPct: number;
}

export interface PromotionCheck {
  key: string;
  label: string;
  passed: boolean;
  actual: string;
  required: string;
}

export interface PromotionEvaluation {
  /** True only when EVERY check passes. Never itself enables anything. */
  wouldQualify: boolean;
  ownerApproved: boolean;
  agenticLiveEnabled: boolean;
  thresholdsAreOwnerSet: boolean;
  provisional: boolean;
  checks: PromotionCheck[];
  blockers: string[];
}

export const DEFAULT_THRESHOLDS: PromotionThresholds = {
  minSampleSize: 200,
  minNetPnl: 0,
  minExpectancy: 0,
  minProfitFactor: 1.3,
  maxDrawdownPct: 15,
  maxDegradedRatePct: 20,
  requireZeroMissingTrace: true,
  requireZeroRiskViolations: true,
};

export function profitFactor(grossProfit: number, grossLoss: number): number | null {
  if (!(grossLoss > 0)) return grossProfit > 0 ? null : 0;
  return Number((grossProfit / grossLoss).toFixed(4));
}

/** Peak-to-trough drawdown of a cumulative P&L curve, as a percent of peak. */
export function maxDrawdownPct(pnlSequence: number[]): number {
  let cum = 0;
  let peak = 0;
  let worst = 0;
  for (const pnl of pnlSequence) {
    cum += pnl;
    if (cum > peak) peak = cum;
    if (peak > 0) {
      const dd = ((peak - cum) / peak) * 100;
      if (dd > worst) worst = dd;
    }
  }
  return Number(worst.toFixed(4));
}

/**
 * Pure evaluation. Deliberately returns `wouldQualify` rather than any kind of
 * enablement: promotion always requires a separate, explicit owner action.
 */
export function evaluatePromotion(
  metrics: PromotionMetrics,
  thresholds: PromotionThresholds,
  state: { ownerApproved: boolean; agenticLiveEnabled: boolean; thresholdsAreOwnerSet: boolean },
): PromotionEvaluation {
  const checks: PromotionCheck[] = [
    {
      key: "sample_size",
      label: "Sample size",
      passed: metrics.sampleSize >= thresholds.minSampleSize,
      actual: String(metrics.sampleSize),
      required: `>= ${thresholds.minSampleSize} closed paper trades`,
    },
    {
      key: "net_pnl",
      label: "Net P&L",
      passed: metrics.netPnl > thresholds.minNetPnl,
      actual: metrics.netPnl.toFixed(2),
      required: `> ${thresholds.minNetPnl}`,
    },
    {
      key: "expectancy",
      label: "Expectancy per trade",
      passed: metrics.expectancy > thresholds.minExpectancy,
      actual: metrics.expectancy.toFixed(4),
      required: `> ${thresholds.minExpectancy}`,
    },
    {
      key: "profit_factor",
      label: "Profit factor",
      passed: metrics.profitFactor != null && metrics.profitFactor >= thresholds.minProfitFactor,
      actual: metrics.profitFactor == null ? "n/a" : metrics.profitFactor.toFixed(2),
      required: `>= ${thresholds.minProfitFactor}`,
    },
    {
      key: "max_drawdown",
      label: "Maximum drawdown",
      passed: metrics.maxDrawdownPct <= thresholds.maxDrawdownPct,
      actual: `${metrics.maxDrawdownPct.toFixed(2)}%`,
      required: `<= ${thresholds.maxDrawdownPct}%`,
    },
    {
      key: "risk_compliance",
      label: "Risk-rule compliance",
      passed: !thresholds.requireZeroRiskViolations || metrics.riskRuleViolations === 0,
      actual: String(metrics.riskRuleViolations),
      required: thresholds.requireZeroRiskViolations ? "0 violations" : "not enforced",
    },
    {
      key: "missing_trace",
      label: "Missing-trace violations",
      passed: !thresholds.requireZeroMissingTrace || metrics.missingTraceViolations === 0,
      actual: String(metrics.missingTraceViolations),
      required: thresholds.requireZeroMissingTrace ? "0" : "not enforced",
    },
    {
      key: "ai_participation",
      label: "Degraded AI participation rate",
      passed: metrics.degradedRatePct <= thresholds.maxDegradedRatePct,
      actual: `${metrics.degradedRatePct.toFixed(1)}%`,
      required: `<= ${thresholds.maxDegradedRatePct}%`,
    },
    {
      key: "execution_integrity",
      label: "Execution integrity",
      passed: metrics.executionIntegrityPct >= 100,
      actual: `${metrics.executionIntegrityPct.toFixed(1)}%`,
      required: "100% of executions carry a complete trace",
    },
  ];

  const blockers = checks.filter((c) => !c.passed).map((c) => c.key);
  if (!state.ownerApproved) blockers.push("owner_approval_missing");
  if (!state.thresholdsAreOwnerSet) blockers.push("thresholds_are_defaults_not_owner_set");

  return {
    wouldQualify: checks.every((c) => c.passed) && state.ownerApproved && state.thresholdsAreOwnerSet,
    ownerApproved: state.ownerApproved,
    agenticLiveEnabled: state.agenticLiveEnabled,
    thresholdsAreOwnerSet: state.thresholdsAreOwnerSet,
    provisional: !state.thresholdsAreOwnerSet,
    checks,
    blockers,
  };
}

/**
 * The single runtime answer to "may the agentic path submit a LIVE order?".
 * Kept deliberately trivial and pessimistic: the only `true` requires the
 * owner-approved database gate AND a separate deployment flag, and no caller
 * in this codebase currently routes live execution through the agentic path.
 */
export function agenticLiveExecutionAllowed(
  gate: { agenticLiveEnabled: boolean; ownerApproved: boolean } | null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!gate?.agenticLiveEnabled || !gate.ownerApproved) return false;
  return String(env.AGENTIC_LIVE_EXECUTION_ENABLED ?? "").toLowerCase() === "true";
}
