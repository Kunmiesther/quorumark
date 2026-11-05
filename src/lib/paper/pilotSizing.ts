/**
 * Pilot-sizing helper (TS side) — thin wrapper that re-exports the pure
 * primitives from broker/translator so the paper engine and any
 * non-broker consumer can import them without pulling in Fastify.
 *
 * Both sides (broker + paper engine) load from
 * shared/mainnet_parity_constants.json via parityConstants.ts.
 */
import { PARITY } from "./parityConstants";

const PILOT = PARITY.pilot;

export const PILOT_RESERVE_FLOOR_USD: number = PILOT.allocation_reserve_floor_usd;
export const PILOT_CEILING_USD: number = PILOT.allocation_ceiling_usd;
export const PILOT_MAX_LEVERAGE: number = PILOT.max_leverage;

export function pilotAllocation(equityUsd: number): number {
  if (!Number.isFinite(equityUsd)) return 0;
  if (equityUsd <= PILOT_RESERVE_FLOOR_USD) return 0;
  return Math.min(equityUsd - PILOT_RESERVE_FLOOR_USD, PILOT_CEILING_USD);
}

export function pilotLeverage(requested: number = PILOT_MAX_LEVERAGE): number {
  const r = Number.isFinite(requested) ? Math.floor(requested) : PILOT_MAX_LEVERAGE;
  return Math.max(1, Math.min(r, PILOT_MAX_LEVERAGE));
}
