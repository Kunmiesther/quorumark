/**
 * Venue registry. Adding a venue is: implement VenueAdapter → register here
 * → done. Arbiter modules consume ONLY the registry, never a specific
 * adapter class.
 *
 * Registry policy:
 *   - `buildDefaultRegistry(fetchImpl?)` returns the venues currently used
 *     by the paper engine: ApeX perp (funding + prices) and Kraken spot (real
 *     hedge leg). If Kraken is unreachable at runtime the caller substitutes
 *     SyntheticSpotVenue via `buildFallbackRegistry`.
 *   - `spreadArbEligible(registry)` returns whether Module 5 has at least
 *     TWO venues with real, independent price feeds. Synthetic-only spot →
 *     no divergence → module inert.
 */
import type { VenueAdapter } from "./VenueAdapter";
import { ApexPerpVenue } from "./ApexPerpVenue";
import { KrakenSpotVenue } from "./KrakenSpotVenue";
import { SyntheticSpotVenue } from "./SyntheticSpotVenue";

export type { VenueAdapter, VenueKind } from "./VenueAdapter";
export { ApexPerpVenue, KrakenSpotVenue, SyntheticSpotVenue };

export interface VenueRegistry {
  venues: VenueAdapter[];
  /** Return a venue by id, or null if not registered. */
  get(venueId: string): VenueAdapter | null;
  /** Venues that expose a funding rate (perp). */
  fundingVenues(): VenueAdapter[];
  /** Ordered venue pairs (a, b) with a.venueId < b.venueId. */
  pairs(): Array<[VenueAdapter, VenueAdapter]>;
}

function makeRegistry(venues: VenueAdapter[]): VenueRegistry {
  const sorted = [...venues].sort((a, b) => a.venueId.localeCompare(b.venueId));
  return {
    venues: sorted,
    get(venueId) {
      return sorted.find((v) => v.venueId === venueId) ?? null;
    },
    fundingVenues() {
      return sorted.filter((v) => typeof v.getFundingRate === "function");
    },
    pairs() {
      const out: Array<[VenueAdapter, VenueAdapter]> = [];
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          out.push([sorted[i], sorted[j]]);
        }
      }
      return out;
    },
  };
}

export function buildDefaultRegistry(fetchImpl: typeof fetch = fetch): VenueRegistry {
  return makeRegistry([new ApexPerpVenue(fetchImpl), new KrakenSpotVenue(fetchImpl)]);
}

export function buildFallbackRegistry(fetchImpl: typeof fetch = fetch): VenueRegistry {
  const apex = new ApexPerpVenue(fetchImpl);
  return makeRegistry([apex, new SyntheticSpotVenue(apex)]);
}

/**
 * True when at least two venues expose INDEPENDENT price feeds — the
 * precondition for Module 5 (cross-venue spread arb) to have any real signal.
 * Synthetic spot mirrors its reference by construction, so a registry that
 * contains a SyntheticSpotVenue is not eligible.
 */
export function spreadArbEligible(registry: VenueRegistry): boolean {
  if (registry.venues.length < 2) return false;
  const hasSynthetic = registry.venues.some((v) => v.venueId === "synthetic_spot");
  return !hasSynthetic;
}
