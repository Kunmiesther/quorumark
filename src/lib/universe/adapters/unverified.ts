/**
 * Explicit fail-closed adapter for unknown or unactivated exchanges.
 * Always returns an empty universe with health='unverified' — the
 * eligibility filter then produces zero eligible symbols. Never fabricates
 * instruments.
 */
import type { UniverseAdapter, VerifiedUniverse } from "../types";

export function unverifiedAdapter(exchange: string): UniverseAdapter {
  return {
    exchange,
    adapterVersion: 0,
    async discover({ environment, marketType, now }) {
      const universe: VerifiedUniverse = {
        exchange,
        environment,
        marketType,
        adapterVersion: 0,
        capabilityVersion: 0,
        health: "unverified",
        instruments: [],
        detail: {
          reason: "no_verified_adapter",
          note: `No runtime adapter registered for exchange="${exchange}"`,
        },
        generatedAt: now ?? Date.now(),
      };
      return universe;
    },
  };
}
