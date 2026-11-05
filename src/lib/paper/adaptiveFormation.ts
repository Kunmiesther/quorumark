/**
 * ADAPTIVE DCA FORMATION PLANNER — pure math (P2).
 *
 * Classifies the market formation without changing wallet sizing. Regime may
 * authorize or block entry, but every authorized campaign uses the universal
 * five-rung wallet contract.
 *
 * Contract (versioned):
 *   FORMATION_SCHEMA_VERSION = 1
 *
 *   mode          rung count guidance    typical regimes
 *   --------      -------------------    ---------------------------
 *   'precision'   5                      strong_uptrend, strong_downtrend
 *   'staged'      5                      developing_trend
 *   'adaptive'    5                      ranging, volatile, unknown
 *   'wait'        0 (no entry)           reversal_forming, opposing_to_open_position
 *
 * `wait` means "Scout does NOT authorize an entry in this regime" — engine
 * callers MUST honor this and skip the candidate. Regime handling for the
 * `opposing_to_open_position` case is the P3 hedge decision, not an entry.
 *
 * Determinism: same input → same output. No IO, no randomness. When a settled
 * wallet balance is supplied, total margin is 5% of that balance.
 */
import type { MarketRegime } from "../scout/regime";
import { ORCHESTRATION } from "./parityConstants";

export const FORMATION_SCHEMA_VERSION = 1 as const;

export type FormationMode = "precision" | "staged" | "adaptive" | "wait";

export interface FormationPlan {
  /** Formation kind — engine uses this to gate entry. */
  mode: FormationMode;
  /** Number of ladder rungs to build. 0 iff `mode==='wait'`. */
  rungs: number;
  /** Per-rung margin so total margin per position stays constant. */
  marginPerRung: number;
  /** Total committed margin (5% of settled wallet balance when supplied). */
  totalMargin: number;
  /** The regime that produced this plan (echoed for audit/UI). */
  regime: MarketRegime;
  /** Reason codes explaining the decision — for Onyx/UI transparency. */
  reasonCodes: string[];
  /** Schema version — bump when semantics change. */
  schemaVersion: typeof FORMATION_SCHEMA_VERSION;
}

export interface FormationInput {
  regime: MarketRegime;
  leverage: number;
  symbol: string;
  settledWalletBalance?: number;
}

/**
 * Compute the adaptive formation plan.
 *
 * PRECEDENCE (checked in order):
 *   1. `wait` for regimes where entry is not authorized
 *      (`reversal_forming`, `opposing_to_open_position`).
 *   2. `precision` for strong confirmed trends.
 *   3. `staged` for developing trends.
 *   4. `adaptive` for ranging, volatile, or unknown regimes.
 *
 * Every authorized mode uses the same five-rung geometry. The mode changes
 * execution context, never the wallet-level sizing contract.
 */
export function planFormation(input: FormationInput): FormationPlan {
  const { regime } = input;

  // 1. WAIT — no entry authorized.
  if (regime === "reversal_forming") {
    return waitPlan(regime, "reversal_forming_no_entry");
  }
  if (regime === "opposing_to_open_position") {
    // P3 hedge path handles this — a plain new entry is NOT the answer here.
    return waitPlan(regime, "opposing_to_open_delegate_to_hedge");
  }

  // 2. PRECISION — strong confirmed trend, universal five-rung execution.
  if (regime === "strong_uptrend" || regime === "strong_downtrend") {
    return sized("precision", regime, input.settledWalletBalance, [
      "regime_strong_confirmed",
      "universal_five_rung_wallet_campaign",
    ]);
  }

  // 3. STAGED — developing trend, same execution geometry.
  if (regime === "developing_trend") {
    return sized("staged", regime, input.settledWalletBalance, [
      "regime_developing_trend",
      "universal_five_rung_wallet_campaign",
    ]);
  }

  // 4. ADAPTIVE — ranging / volatile / unknown. Strategy context changes;
  //    capital geometry does not.
  return sized("adaptive", regime, input.settledWalletBalance, [
    regime === "ranging"
      ? "regime_ranging"
      : regime === "volatile"
        ? "regime_volatile"
        : "regime_unknown",
    "universal_five_rung_wallet_campaign",
  ]);
}

function waitPlan(regime: MarketRegime, code: string): FormationPlan {
  return {
    mode: "wait",
    rungs: 0,
    marginPerRung: 0,
    totalMargin: 0,
    regime,
    reasonCodes: [code],
    schemaVersion: FORMATION_SCHEMA_VERSION,
  };
}

function sized(
  mode: Exclude<FormationMode, "wait">,
  regime: MarketRegime,
  settledWalletBalance: number | undefined,
  reasonCodes: string[],
): FormationPlan {
  const rungs = ORCHESTRATION.campaign_rung_count;
  const balance = Number(settledWalletBalance ?? 0);
  const totalMargin = balance > 0
    ? balance * ORCHESTRATION.campaign_margin_fraction_of_settled_wallet_balance
    : 0;
  return {
    mode,
    rungs,
    marginPerRung: totalMargin / rungs,
    totalMargin,
    regime,
    reasonCodes,
    schemaVersion: FORMATION_SCHEMA_VERSION,
  };
}
