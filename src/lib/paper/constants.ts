/**
 * Paper-engine constants — extracted from engine.ts (Phase 3, step 1).
 *
 * SCOPE (deliberate, minimal):
 *   - Numeric constants and one pure helper (`shouldTriggerMaxLoss`) that carry
 *     the strategy/sizing/leverage/fee/PnL semantics. These values MUST NOT
 *     change from what engine.ts historically exported — Phase 3 forbids any
 *     strategy math or fee/PnL change.
 *   - `engine.ts` re-exports every name from this module so callers importing
 *     from "@/lib/paper/engine" keep the same public surface (compatibility
 *     facade).
 *
 * NON-GOALS:
 *   - No I/O, no Supabase types, no strategy evaluation.
 *   - No new abstractions or wrappers.
 */

// ─── DYNAMIC UNIVERSE / ONYX AI FLAGS ─────────────────────────────────────
/**
 * Dynamic-universe execution pipeline (Scout ranker → capacity resolver →
 * Onyx approval → paper_execution_slots) is DISABLED for the paper engine.
 *
 * While false:
 *   - `runPaperTick` constructs the `universeGate` as inactive; the legacy
 *     Hunter / Sniper / Accumulator open path (`repoOpenPosition`) is the
 *     sole authority for opening paper positions.
 *   - Phase A.5 Scout ingestion still runs, but every synthesized candidate
 *     is rejected with `blocked_universe_capacity` because the gate rejects
 *     every symbol. The Phase A.5 code path is intentionally preserved so
 *     re-enabling the flag restores the epoch/scan/pod pipeline in one flip.
 *
 * DO NOT flip this to `true` without also re-wiring `computeUniverseGate`
 * into `runPaperTick` and verifying the epoch/scan/pod path end-to-end.
 * Mainnet is a separate authority gate and MUST remain fail-closed even if
 * this flag is on.
 */
export const DYNAMIC_UNIVERSE_ENABLED = false;

/**
 * Onyx LLM decision path. When false, the deterministic guardrail + ranking
 * path in `src/lib/onyx/decide.ts` is the SOLE decision authority; no HTTP
 * call is made to the Lovable AI Gateway, `aiCalled` is always `false`, and
 * `decision.closes` may only ever carry the mechanical `scout_bos` reason.
 * The AI-originated `bank_profit` close path is unreachable while this flag
 * is off. Money-path invariant: no LLM output can open, close, or size a
 * paper position.
 */
export const ONYX_AI_ENABLED = false;

// ─── ONYX EXECUTION COMMANDER (Stage 2) ────────────────────────────────────
import { ORCHESTRATION } from "./parityConstants";
export const ONYX_MAX_TOTAL_OPEN = ORCHESTRATION.max_active_opportunities;
export const ONYX_MAX_ALT_POSITIONS = ORCHESTRATION.max_active_opportunities;
export const ONYX_BENCH_STOPS = 3;
export const ONYX_RECENT_TRADE_LIMIT = 200;


// ─── CROSS-MARGIN ACCOUNT MODEL ────────────────────────────────────────────
export const STARTING_ACCOUNT_BALANCE = 3_600;
export const MMR = 0.005;
export const MAX_HEAT = 4.0;

// ─── SIZING / FEES / VENUE ────────────────────────────────────────────────
export const WALLET_BASE = 600;
export const MARGIN_FRACTION = 0.10;
export const TARGET_LEVERAGE = 100;
export const TAKER_BPS = 5;
export const SLIP_BPS = 2;
export const FEE_RATE = TAKER_BPS / 10_000;
export const SLIP_RATE = SLIP_BPS / 10_000;
/** Canonical execution clock. Signals, fills and position management run only
 * after a completed 15-minute candle. */
export const EXECUTION_INTERVAL_MIN = ORCHESTRATION.decision_interval_min;
/** Deterministic held-position supervision; never creates a new entry. */
export const HEALTH_INTERVAL_MIN = ORCHESTRATION.health_interval_min;
/** Venue universe considered by each coordinated selection pass. */
export const SCAN_UNIVERSE_SIZE = ORCHESTRATION.scan_universe_size;
/** Native higher-timeframe feeds used to qualify a 15-minute entry. */
export const SETUP_INTERVAL_1H_MIN = 60;
export const SETUP_INTERVAL_4H_MIN = 240;
/** Compatibility export used throughout the paper engine. */
export const INTERVAL_MIN = EXECUTION_INTERVAL_MIN;
export const FETCH_LIMIT = 198;
import { TP_GEOMETRY, RISK, HUNTER, ONYX, LADDER } from "./parityConstants";
export const MIN_STRUCTURAL_TP_DISTANCE_PCT = TP_GEOMETRY.min_structural_tp_distance_pct;
export const MIN_TP_TO_STOP_DISTANCE_RATIO = TP_GEOMETRY.min_tp_to_stop_distance_ratio;

// ─── HARD MAX-LOSS CAP ────────────────────────────────────────────────────
export const MAX_LOSS_MARGIN_FRAC = RISK.max_loss_margin_frac;

// ─── ONYX DISCRETIONARY CLOSE POLICY ──────────────────────────────────────
/**
 * Bank-profit threshold — the ONLY path that lets Onyx close a position
 * discretionarily. Position must be net-profitable by ≥ this fraction of
 * margin AFTER modeled fees/slippage. Prevents "close because red" and
 * "close to free capacity". 30 = +30 % margin ROI (≈ +$18 on a $60 DCA
 * position). Used by `validateAiClose` in `src/lib/onyx/decide.ts`.
 */
export const ONYX_BANK_PROFIT_MARGIN_ROI_PCT = ONYX.bank_profit_margin_roi_pct;

/**
 * True when the newest candle's worst-case unrealized loss on a position is
 * at or beyond MAX_LOSS_MARGIN_FRAC of its margin.
 *
 * Preserves the exact predicate from engine.ts:
 *   margin > 0 && (-unrealizedWorst) >= margin * MAX_LOSS_MARGIN_FRAC
 */
export function shouldTriggerMaxLoss(
  margin: number,
  unrealizedWorst: number,
): boolean {
  return margin > 0 && -unrealizedWorst >= margin * MAX_LOSS_MARGIN_FRAC;
}

// ─── HUNTER (high_vol regime) ─────────────────────────────────────────────
export const HUNTER_K_THRESHOLD = HUNTER.k_threshold;
export const HUNTER_RETRACE_WINDOW = HUNTER.retrace_window;

// ─── SCOUT TREND FILTER ────────────────────────────────────────────────────
export const TREND_FILTER_ENABLED = true;
export const TREND_NEUTRAL_BLOCKS = false;

/** Effective leverage = min(target, per-symbol venue cap). */
export function effectiveLeverage(
  symbolMaxLeverage: number | null | undefined,
): number {
  const cap =
    symbolMaxLeverage && symbolMaxLeverage > 0
      ? Number(symbolMaxLeverage)
      : TARGET_LEVERAGE;
  return Math.min(TARGET_LEVERAGE, cap);
}

/** Default symbol seed set. */
export const DEFAULT_PAPER_SYMBOLS = [
  ...ORCHESTRATION.scan_symbols,
] as const;

/**
 * LEGACY CANONICAL FORCED-LEVERAGE ALLOWLIST.
 *
 * The exported identifier retains its old name for compatibility, but the
 * active campaign rung count is universally five. This set now controls only
 * which legacy canonical symbol may force TARGET_LEVERAGE.
 *
 * All other symbols (LINK-USDT, SOL-USDT, XRP-USDT, DOGE-USDT, AVAX-USDT,
 * PENGU-USDT, HOOD-USDT, SUI-USDT, APEX-USDT, and any future symbol) MUST
 * preserve venue-capped leverage through `effectiveLeverage(max_leverage)`.
 */
export const EIGHT_RUNG_CANONICAL_SYMBOLS: ReadonlySet<string> = new Set(
  LADDER.eight_rung_canonical_symbols,
);

/** True iff the symbol is on the legacy canonical forced-leverage allowlist. */
export function isEightRungSymbol(symbol: string | null | undefined): boolean {
  return typeof symbol === "string" && EIGHT_RUNG_CANONICAL_SYMBOLS.has(symbol);
}
