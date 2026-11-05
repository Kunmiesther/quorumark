/**
 * HEDGE PLANNER — pure decision module (P3).
 *
 * When Scout classifies the current market regime as
 * `opposing_to_open_position` — i.e. there's an open position AND a
 * confirmed opposing signal — this planner returns the deterministic
 * action ONYX should take, given the venue's actual capabilities.
 *
 * The planner is pure: it does NOT touch orders, order-audit, or the
 * broker. Its output is what to do; the execution layer decides HOW
 * (real orders, paper simulation, or refuse-and-log) subject to the
 * standard mainnet/kill-switch/reservation gates.
 *
 * Decision matrix:
 *
 *   regime                            venue.hedge_supported   action
 *   opposing_to_open_position         true                    native_hedge
 *   opposing_to_open_position         false                   close_and_reverse
 *   opposing_to_open_position         unknown / no capability hold_and_flag
 *   any other regime                  —                       no_action
 *
 * `close_and_reverse` is a two-step: (1) close the existing position at
 * market, (2) open the opposing entry with the FORMATION selected by the
 * adaptive planner for the OPPOSING direction under the CURRENT regime.
 * The two steps are individually gated by the standard mainnet /
 * kill-switch / capability preflight — this planner never issues them.
 *
 * `hold_and_flag` is the fail-safe when we cannot determine hedge support
 * (missing capability row, stale audit). The engine surfaces a Scout
 * evaluation "hedge_unresolved_capability" and takes NO action; the user
 * or an operator resolves the capability then the next tick re-decides.
 */
import type { MarketRegime } from "../scout/regime";
import type { Direction } from "./signal";

export const HEDGE_SCHEMA_VERSION = 1 as const;

export type HedgeAction =
  | "native_hedge"
  | "close_and_reverse"
  | "hold_and_flag"
  | "no_action";

export interface HedgePlan {
  action: HedgeAction;
  /** The direction the NEW opposing exposure should have. */
  opposingDirection: Direction | null;
  reasonCodes: string[];
  schemaVersion: typeof HEDGE_SCHEMA_VERSION;
}

export interface HedgePlanInput {
  regime: MarketRegime;
  /** Direction of the currently open position (null if no open position). */
  openDirection: Direction | null;
  /** True when the venue advertises hedge_supported. */
  hedgeSupported: boolean | null;
  /** Signal direction Scout is proposing (should oppose openDirection). */
  proposedDirection: Direction | null;
}

const V = HEDGE_SCHEMA_VERSION;

export function planHedge(input: HedgePlanInput): HedgePlan {
  const { regime, openDirection, hedgeSupported, proposedDirection } = input;

  // Only the opposing regime triggers hedge decisions. Any other regime is
  // handled by the adaptive formation planner (which returns `wait` for
  // reversal_forming). No overlap between the two planners.
  if (regime !== "opposing_to_open_position") {
    return {
      action: "no_action",
      opposingDirection: null,
      reasonCodes: ["regime_not_opposing"],
      schemaVersion: V,
    };
  }

  // The regime is by definition "open exists AND opposing signal exists",
  // so both directions MUST be present. If either is missing the input is
  // inconsistent — refuse to act.
  if (!openDirection || !proposedDirection) {
    return {
      action: "hold_and_flag",
      opposingDirection: null,
      reasonCodes: ["hedge_input_inconsistent"],
      schemaVersion: V,
    };
  }
  if (openDirection === proposedDirection) {
    // Not actually opposing — treat as no action.
    return {
      action: "no_action",
      opposingDirection: null,
      reasonCodes: ["proposed_matches_open_direction"],
      schemaVersion: V,
    };
  }

  if (hedgeSupported === null) {
    return {
      action: "hold_and_flag",
      opposingDirection: proposedDirection,
      reasonCodes: ["hedge_unresolved_capability"],
      schemaVersion: V,
    };
  }

  if (hedgeSupported) {
    return {
      action: "native_hedge",
      opposingDirection: proposedDirection,
      reasonCodes: ["native_hedge_available", `open_${openDirection}_vs_signal_${proposedDirection}`],
      schemaVersion: V,
    };
  }

  return {
    action: "close_and_reverse",
    opposingDirection: proposedDirection,
    reasonCodes: ["venue_no_hedge_close_and_reverse", `open_${openDirection}_vs_signal_${proposedDirection}`],
    schemaVersion: V,
  };
}
