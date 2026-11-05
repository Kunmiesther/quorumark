/**
 * ARBITER — funding-rate arbitrage overlay (regime-independent).
 *
 * PURE detector + credit math. This module does NOT open positions on its
 * own; the engine consumes `evaluateArbiterEntry` and drives the paper
 * position lifecycle. Arbiter runs OUTSIDE the regime dispatch — it does
 * not occupy the armed_leg slot.
 *
 * ── Data source ──────────────────────────────────────────────────────────
 * ApeX Omni public REST exposes funding on the per-symbol ticker:
 *   GET https://omni.apex.exchange/api/v3/ticker?symbol=<BASEQUOTE>
 *   → data[0].fundingRate           (current, decimal, per 8h interval)
 *   → data[0].predictedFundingRate  (next accrual)
 *   → data[0].nextFundingTime       (ISO 8601 UTC)
 * Verified reachable from this environment (see AGENTS report). Symbol
 * format uses NO dash (BTCUSDT), unlike the dashed candle symbol (BTC-USDT).
 *
 * ── Semantics ────────────────────────────────────────────────────────────
 * Funding convention (ApeX / most perps):
 *   funding_rate > 0  → LONGS pay SHORTS   → open SHORT to receive.
 *   funding_rate < 0  → SHORTS pay LONGS   → open LONG to receive.
 * Per-interval credit on a position: pnl_delta = notional * |funding_rate|
 * on the receiving side (paid at each funding timestamp the position is held).
 *
 * Exits:
 *   - After ARBITER_HOLD_INTERVALS funding timestamps have accrued.
 *   - Early if funding rate flips sign (harvest done, or reverses against us).
 *   - Guardian 5m adverse BOS still applies for catastrophic price moves.
 * HTF promotion does NOT apply to arbiter (not a trend trade).
 *
 * ── Activation ───────────────────────────────────────────────────────────
 * Ships behind `ARBITER.enabled = false` in shared/mainnet_parity_constants.json.
 * Rationale: the detector + funding math are deterministic and tested here,
 * but the engine overlay wiring (per-funding-timestamp accrual against open
 * paper positions, correlation/heat interaction) is a follow-up (DEBT-09 in
 * docs/MAINNET_PARITY.md). Do NOT flip the flag before that wiring lands.
 */
import type { Direction } from "./signal";
import { ARBITER } from "./parityConstants";

export const ARBITER_ENABLED: boolean = ARBITER.enabled;
export const ARBITER_MIN_FUNDING_RATE: number = ARBITER.min_funding_rate;
// v1 detector legacy sizing knobs — v2 (arbiter/harvester.ts) supersedes these;
// kept as local constants so the v1 pure-math helpers below stay callable for
// tests and the v1 arbiter path remains inert behind ARBITER_ENABLED=false.
export const ARBITER_ALLOCATION_FRAC: number = 0.05;
export const ARBITER_HOLD_INTERVALS: number = 1;
export const ARBITER_FUNDING_INTERVAL_HOURS: number = ARBITER.funding_interval_hours;

export interface ArbiterEntry {
  direction: Direction;
  /** Notional as a fraction of account equity (allocation_frac). */
  notionalFrac: number;
  /** How many funding intervals to hold (from config). */
  holdIntervals: number;
  /** Signed funding rate that triggered the entry (for telemetry). */
  triggerRate: number;
}

export type ArbiterBlockReason =
  | "arbiter_disabled"
  | "arbiter_rate_below_threshold"
  | "arbiter_rate_zero_or_nan";

export type ArbiterDecision =
  | { open: true; entry: ArbiterEntry }
  | { open: false; reason: ArbiterBlockReason };

/**
 * Deterministic entry decision from a single funding rate reading.
 * The engine calls this per symbol per tick once a fresh rate is fetched.
 */
export function evaluateArbiterEntry(fundingRate: number): ArbiterDecision {
  if (!ARBITER_ENABLED) return { open: false, reason: "arbiter_disabled" };
  if (!Number.isFinite(fundingRate) || fundingRate === 0) {
    return { open: false, reason: "arbiter_rate_zero_or_nan" };
  }
  if (Math.abs(fundingRate) < ARBITER_MIN_FUNDING_RATE) {
    return { open: false, reason: "arbiter_rate_below_threshold" };
  }
  // Receiving side: positive rate → shorts receive; negative → longs receive.
  const direction: Direction = fundingRate > 0 ? "short" : "long";
  return {
    open: true,
    entry: {
      direction,
      notionalFrac: ARBITER_ALLOCATION_FRAC,
      holdIntervals: ARBITER_HOLD_INTERVALS,
      triggerRate: fundingRate,
    },
  };
}

/**
 * Funding credit accrued on the receiving side for a given notional and
 * signed rate. Returns a POSITIVE PnL delta when the position is on the
 * receiving side, NEGATIVE if the position ended up on the paying side (this
 * is what the flip-sign exit protects against — the engine credits the
 * accrual first, then re-evaluates and exits).
 */
export function fundingCredit(
  notional: number,
  fundingRate: number,
  direction: Direction,
): number {
  // Receiving side pays negative; paying side pays positive to counterparty.
  // Position PnL delta = -rate * notional * sign(direction), where long=+1.
  const dirSign = direction === "long" ? 1 : -1;
  return -fundingRate * notional * dirSign;
}

/**
 * Exit condition: the current funding rate has flipped sign against the
 * position's original receiving direction. Called by the engine at each
 * funding-timestamp evaluation.
 */
export function shouldExitOnFlip(
  originalRate: number,
  currentRate: number,
): boolean {
  if (!Number.isFinite(originalRate) || !Number.isFinite(currentRate)) return false;
  if (originalRate === 0 || currentRate === 0) return false;
  return Math.sign(originalRate) !== Math.sign(currentRate);
}

/**
 * Fetch the current + predicted funding rate for a symbol from ApeX Omni.
 * The symbol argument accepts either dashed ("BTC-USDT") or plain
 * ("BTCUSDT"); ApeX expects the plain form.
 *
 * Returns null on any transport or parsing error — the caller MUST treat
 * a null as "no signal this tick" and NEVER fabricate a rate.
 */
export interface ApexFunding {
  symbol: string;
  fundingRate: number;
  predictedFundingRate: number;
  nextFundingTimeMs: number | null;
}

export async function fetchApexFunding(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ApexFunding | null> {
  const plain = symbol.replace(/-/g, "");
  const url = `https://omni.apex.exchange/api/v3/ticker?symbol=${encodeURIComponent(plain)}`;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const row = body?.data?.[0];
    if (!row) return null;
    const rate = Number(row.fundingRate);
    const pred = Number(row.predictedFundingRate);
    if (!Number.isFinite(rate) || !Number.isFinite(pred)) return null;
    const nextIso = typeof row.nextFundingTime === "string" ? row.nextFundingTime : null;
    const next = nextIso ? Date.parse(nextIso) : NaN;
    return {
      symbol: plain,
      fundingRate: rate,
      predictedFundingRate: pred,
      nextFundingTimeMs: Number.isFinite(next) ? next : null,
    };
  } catch {
    return null;
  }
}
