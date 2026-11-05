/**
 * Shared parity constants loader (TypeScript side).
 *
 * Reads shared/mainnet_parity_constants.json and re-exports typed values.
 * Companion to shared/parity_constants.py. Both sides load the SAME file —
 * that is the mechanism enforcing paper<->live parity for the fields listed
 * in docs/MAINNET_PARITY.md §2.
 *
 * Do NOT declare a duplicate numeric literal for any value that lives in the
 * JSON. Update the JSON and both sides re-import.
 */
import raw from "../../../shared/mainnet_parity_constants.json";

export const PARITY = raw as typeof raw;

export const ORCHESTRATION = PARITY.orchestration;
export const ACCUMULATOR = PARITY.accumulator;
export const HUNTER = PARITY.hunter;
export const SNIPER = PARITY.sniper;
export const ELIGIBILITY = PARITY.eligibility;
export const ENTRY_LOCKOUT = PARITY.entry_lockout;
export const HTF_PROMOTION = PARITY.htf_promotion;
export const LADDER = PARITY.ladder;
export const TP_GEOMETRY = PARITY.tp_geometry;
export const RISK = PARITY.risk;
export const ONYX = PARITY.onyx;
export const GUARDIAN = PARITY.guardian;
export const ENUMS = PARITY.enums;
export const REGIME_ROUTING = PARITY.regime_routing;
export const VANGUARD = PARITY.vanguard;
export const ARBITER = PARITY.arbiter;
export const SPREAD_ARB = PARITY.spread_arb;
export const VENUES = PARITY.venues;
