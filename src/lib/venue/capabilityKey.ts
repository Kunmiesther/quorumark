/**
 * Deterministic capability-key serialization.
 *
 * Includes exchange, adapter version, environment, market/product type,
 * account/position mode, and symbol (when rules vary per symbol). The
 * serialized key is used for lookup caching and audit correlation only —
 * the database's uniqueness lives in its composite index.
 */
import type { CapabilityKey } from "./types";

export function serializeCapabilityKey(k: CapabilityKey): string {
  const symbol = k.symbol ?? "*";
  return [
    k.exchange.toLowerCase(),
    k.adapter_version,
    k.environment,
    k.market_type,
    k.position_mode,
    symbol,
  ].join("|");
}

export function isSameCapabilityScope(a: CapabilityKey, b: CapabilityKey): boolean {
  return serializeCapabilityKey(a) === serializeCapabilityKey(b);
}
