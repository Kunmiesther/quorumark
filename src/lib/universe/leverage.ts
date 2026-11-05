/**
 * Inverse-margin leverage sizer.
 *
 * Rules (v1):
 *   - Exchange max leverage is only an UPPER bound. ONYX may choose lower.
 *   - Approved leverage is the highest safe value that satisfies:
 *       liquidation distance ≥ minLiquidationDistancePct
 *       maintenance margin   ≤ available margin
 *       volatility guard     (adverse move ≤ tolerated buffer)
 *   - Given an approved notional and approved leverage, required margin =
 *       ceil(notional / leverage, exchange minimum increments) — never
 *       inflating the approved notional or the approved risk.
 *   - If leverage metadata is stale / missing, the candidate is REJECTED
 *     (returns null).
 */

export interface LeverageBounds {
  exchangeMaxLeverage: number | null;
  metadataAgeMs: number;
  maxMetadataAgeMs: number;
  /** Minimum required buffer between entry price and liquidation, as a fraction. */
  minLiquidationDistancePct: number;
  /** Recent adverse move used as a stress test, as a fraction. */
  adverseMovePct: number;
  /** Optional minimum leverage allowed (defaults to 1). */
  minLeverage?: number;
  /** User-selected leverage ceiling. It may be lowered, never raised. */
  requestedLeverage?: number;
  /** Strategy-specific leverage ceiling. */
  strategyMaxLeverage?: number;
  /** Connected account/product eligibility ceiling. */
  accountMaxLeverage?: number;
  /** Independent risk-engine ceiling. */
  riskMaxLeverage?: number;
}

export interface SizingRequest {
  approvedNotionalUsd: number;
  availableMarginUsd: number;
  bounds: LeverageBounds;
  /** Rounding minimum for margin, in USD (e.g. exchange step). */
  marginStepUsd?: number;
}

export interface SizingDecision {
  approvedLeverage: number;
  approvedNotionalUsd: number;
  requiredMarginUsd: number;
  limitingReason:
    | "requested"
    | "strategy_max"
    | "exchange_max"
    | "account_max"
    | "risk_max"
    | "liquidation_distance"
    | "available_margin"
    | "min_leverage";
}

export type SizingResult =
  | { ok: true; decision: SizingDecision }
  | { ok: false; reason: string };

/**
 * Highest safe leverage where 1 / L ≥ minLiquidationDistancePct + adverseMovePct.
 * This is a conservative approximation of "adverse move must not cross the
 * liquidation price". Real exchanges add maintenance margin — callers should
 * supply an inflated minLiquidationDistancePct to absorb that.
 */
function maxSafeLeverage(bounds: LeverageBounds): number {
  const required = bounds.minLiquidationDistancePct + bounds.adverseMovePct;
  if (required <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor(1 / required);
}

export function sizePosition(req: SizingRequest): SizingResult {
  const {
    approvedNotionalUsd,
    availableMarginUsd,
    bounds,
    marginStepUsd = 0.01,
  } = req;

  if (!(approvedNotionalUsd > 0)) return { ok: false, reason: "invalid_notional" };
  if (!(availableMarginUsd > 0)) return { ok: false, reason: "insufficient_margin" };

  if (bounds.exchangeMaxLeverage == null) {
    return { ok: false, reason: "leverage_metadata_missing" };
  }
  if (bounds.metadataAgeMs > bounds.maxMetadataAgeMs) {
    return { ok: false, reason: "leverage_metadata_stale" };
  }
  if (!(bounds.exchangeMaxLeverage >= 1)) {
    return { ok: false, reason: "leverage_below_1" };
  }

  const minL = Math.max(1, bounds.minLeverage ?? 1);
  const safeCap = maxSafeLeverage(bounds);
  const exchangeCap = Math.floor(bounds.exchangeMaxLeverage);

  const rawCeilings: Array<[SizingDecision["limitingReason"], number]> = [
    ["requested", bounds.requestedLeverage ?? Number.POSITIVE_INFINITY],
    ["strategy_max", bounds.strategyMaxLeverage ?? Number.POSITIVE_INFINITY],
    ["exchange_max", exchangeCap],
    ["account_max", bounds.accountMaxLeverage ?? Number.POSITIVE_INFINITY],
    ["risk_max", bounds.riskMaxLeverage ?? Number.POSITIVE_INFINITY],
    ["liquidation_distance", safeCap],
  ];
  const ceilings: Array<[SizingDecision["limitingReason"], number]> = rawCeilings.map(
    ([reason, value]) => [reason, Number.isFinite(value) ? Math.floor(value) : value],
  );

  if (ceilings.some(([, value]) => value < 1)) {
    return { ok: false, reason: "invalid_leverage_ceiling" };
  }

  const candidate = Math.min(...ceilings.map(([, value]) => value));
  if (candidate < minL) return { ok: false, reason: "no_safe_leverage" };

  const approvedLeverage = candidate;
  let limitingReason = ceilings.find(([, value]) => value === candidate)?.[0]
    ?? "exchange_max";

  // Compute required margin at candidate leverage.
  let requiredMargin = approvedNotionalUsd / approvedLeverage;
  // Round UP to margin step to respect exchange minimums.
  requiredMargin = Math.ceil(requiredMargin / marginStepUsd) * marginStepUsd;

  if (requiredMargin > availableMarginUsd) {
    // Try raising leverage no higher than the safe cap — but we're already
    // at min(exchange, safe). Available margin is the bottleneck.
    return { ok: false, reason: "insufficient_margin" };
  }

  // If the caller supplied a higher min, and we ended up above it, that's fine.
  if (approvedLeverage === minL) limitingReason = "min_leverage";

  return {
    ok: true,
    decision: {
      approvedLeverage,
      approvedNotionalUsd,           // never inflated
      requiredMarginUsd: requiredMargin,
      limitingReason,
    },
  };
}
