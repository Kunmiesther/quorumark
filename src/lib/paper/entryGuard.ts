/**
 * ENTRY GUARD — deterministic pre-flight for every candidate open.
 *
 * `planFormation` returns `mode: "wait"` for regimes where a new entry
 * is NOT authorized (`reversal_forming`, `opposing_to_open_position`).
 * Previous engine code let those callers fall back to legacy leverage-
 * tiered geometry (advisory-only). That is no longer acceptable — WAIT
 * means fail-closed, zero orders/intents/rungs. This module is the
 * single source of truth callers use before building any ladder.
 *
 * Pure — no I/O, no persistence. The caller decides what to log and
 * how to advance its per-wallet cursor after a block.
 */
import { planFormation, type FormationPlan } from "./adaptiveFormation";
import type { MarketRegime } from "../scout/regime";

export interface EntryGuardInput {
  regime: MarketRegime;
  leverage: number;
  symbol: string;
}

export interface EntryGuardResult {
  authorized: boolean;
  plan: FormationPlan;
  /** Machine-readable reason present when authorized === false. */
  blockCode: string | null;
  /** Human-readable reason present when authorized === false. */
  blockDetail: string | null;
}

export function evaluateEntryAuthorization(input: EntryGuardInput): EntryGuardResult {
  const plan = planFormation(input);
  if (plan.mode === "wait") {
    return {
      authorized: false,
      plan,
      blockCode: "wait_regime",
      blockDetail: `regime=${plan.regime}; codes=${plan.reasonCodes.join(",")}`,
    };
  }
  return { authorized: true, plan, blockCode: null, blockDetail: null };
}
