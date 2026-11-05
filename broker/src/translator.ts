/**
 * BROKER DIRECTIVE TRANSLATOR — dry-run + pilot-sized.
 *
 * Pure, deterministic. Given a strategy directive (from the paper engine or
 * live worker) and the caller's current equity + venue caps, translate it
 * into the exchange-shaped intent the broker WOULD submit — WITHOUT any
 * signing or network call. In dry-run mode this is what `POST
 * /v1/directives/translate` returns; the same function is called
 * server-side in live mode and its output is then submitted.
 *
 * SAFETY:
 *   - This module NEVER calls the signer, exchange, or DB.
 *   - Leverage is clamped to `pilot.max_leverage` regardless of what the
 *     caller requested or what the venue allows.
 *   - Sizing is clamped by `pilot_allocation(equity)` — a value at or below
 *     the reserve floor produces size=0 (the broker refuses to translate).
 *   - Only the whitelist of directive types from `enums.directive_types`
 *     is honored. Unknown types return { ok:false, reason:'unknown_directive' }.
 */
import PARITY from "./parityConstants";

const PILOT = PARITY.pilot;
const DIRECTIVE_TYPES: readonly string[] = PARITY.enums.directive_types;

export type DirectiveType =
  | "cancel_unfilled_rungs"
  | "close_position"
  | "promote_runner"
  | "cancel_fixed_tp"
  | "set_breakeven_stop"
  | "repair_stop";

export interface TranslateInput {
  directive_type: DirectiveType | string;
  symbol: string;
  side: "long" | "short";
  connection_id: string;
  /** Requested leverage (before pilot clamp). */
  requested_leverage: number;
  /** Caller equity in USD (after fees, unrealized PnL, etc.). */
  equity_usd: number;
  /** Optional entry / stop / limit price context. */
  price?: number;
  intended_stop?: number;
}

export interface TranslateOk {
  ok: true;
  dry_run: true;
  directive_type: DirectiveType;
  symbol: string;
  side: "long" | "short";
  effective_leverage: number;
  allocation_usd: number;
  notional_usd: number;
  reduce_only: boolean;
  intended_stop: number | null;
  emit: boolean;
  notes: string[];
}

export interface TranslateFail {
  ok: false;
  reason:
    | "unknown_directive"
    | "no_pilot_allocation"
    | "invalid_side"
    | "invalid_leverage"
    | "invalid_equity";
  detail?: string;
}

export type TranslateResult = TranslateOk | TranslateFail;

export function pilotAllocation(equityUsd: number): number {
  if (!Number.isFinite(equityUsd)) return 0;
  if (equityUsd <= PILOT.allocation_reserve_floor_usd) return 0;
  return Math.min(
    equityUsd - PILOT.allocation_reserve_floor_usd,
    PILOT.allocation_ceiling_usd,
  );
}

export function pilotLeverage(requested: number): number {
  const r = Number.isFinite(requested) ? Math.floor(requested) : PILOT.max_leverage;
  return Math.max(1, Math.min(r, PILOT.max_leverage));
}

const REDUCE_ONLY_TYPES = new Set<string>([
  "cancel_unfilled_rungs",
  "close_position",
  "cancel_fixed_tp",
  "set_breakeven_stop",
  "repair_stop",
]);

const EMIT_ORDER_TYPES = new Set<string>([
  "close_position",
  "set_breakeven_stop",
  "repair_stop",
]);

export function translateDirective(input: TranslateInput): TranslateResult {
  if (!DIRECTIVE_TYPES.includes(input.directive_type)) {
    return { ok: false, reason: "unknown_directive", detail: String(input.directive_type) };
  }
  if (input.side !== "long" && input.side !== "short") {
    return { ok: false, reason: "invalid_side", detail: String(input.side) };
  }
  if (!Number.isFinite(input.equity_usd)) {
    return { ok: false, reason: "invalid_equity" };
  }
  const alloc = pilotAllocation(input.equity_usd);
  if (alloc <= 0) {
    return { ok: false, reason: "no_pilot_allocation" };
  }
  const lev = pilotLeverage(input.requested_leverage);
  if (lev < 1) return { ok: false, reason: "invalid_leverage" };

  const notes: string[] = [];
  if (input.requested_leverage > PILOT.max_leverage) {
    notes.push(`leverage clamped from ${input.requested_leverage} to ${lev} (pilot ceiling)`);
  }
  const notional = alloc * lev;
  const reduceOnly = REDUCE_ONLY_TYPES.has(input.directive_type);
  const emit = EMIT_ORDER_TYPES.has(input.directive_type);

  return {
    ok: true,
    dry_run: true,
    directive_type: input.directive_type as DirectiveType,
    symbol: input.symbol,
    side: input.side,
    effective_leverage: lev,
    allocation_usd: alloc,
    notional_usd: notional,
    reduce_only: reduceOnly,
    intended_stop: input.intended_stop ?? null,
    emit,
    notes,
  };
}
