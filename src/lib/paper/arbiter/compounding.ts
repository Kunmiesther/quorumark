/**
 * Module 3 — Compounding.
 *
 * working_allocation_frac = clamp(base + cumulative_arb_pnl / equity, base, max)
 * Only NON-NEGATIVE arbiter cumulative PnL grows the allocation; net losses
 * do NOT shrink below the base (base is the floor per spec).
 */
import { ARBITER } from "../parityConstants";

export const BASE_ALLOCATION_FRAC: number = ARBITER.base_allocation_frac;
export const MAX_ALLOCATION_FRAC: number = ARBITER.max_allocation_frac;

export function workingAllocationFrac(
  equityUsd: number,
  arbiterCumulativePnlUsd: number,
): number {
  if (!Number.isFinite(equityUsd) || equityUsd <= 0) return BASE_ALLOCATION_FRAC;
  const growth = Math.max(0, arbiterCumulativePnlUsd) / equityUsd;
  const raw = BASE_ALLOCATION_FRAC + growth;
  return Math.min(MAX_ALLOCATION_FRAC, Math.max(BASE_ALLOCATION_FRAC, raw));
}

export function workingAllocationUsd(
  equityUsd: number,
  arbiterCumulativePnlUsd: number,
): number {
  return equityUsd * workingAllocationFrac(equityUsd, arbiterCumulativePnlUsd);
}
