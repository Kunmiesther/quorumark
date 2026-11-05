/**
 * Adapter registry — resolves an exchange key to its verified universe
 * adapter. Unknown exchanges fail closed via an explicit unverified stub;
 * we NEVER default to a global static symbol list.
 */
import type { UniverseAdapter } from "../types";
import { apexOmniAdapter } from "./apex";
import { bydfiAdapter } from "./bydfi";
import { paperAdapter } from "./paper";
import { unverifiedAdapter } from "./unverified";

const REGISTRY: Record<string, UniverseAdapter> = {
  apex_omni: apexOmniAdapter,
  // Alias: engineGate/scanScope query with exchange='apex' — must resolve to
  // the real apex_omni adapter, not fall through to the unverified stub.
  apex: apexOmniAdapter,
  bydfi: bydfiAdapter,
  paper: paperAdapter,
};

/** Return the adapter for an exchange key, or an explicit fail-closed stub. */
export function getUniverseAdapter(exchange: string): UniverseAdapter {
  const found = REGISTRY[exchange];
  if (found) return found;
  return unverifiedAdapter(exchange);
}
