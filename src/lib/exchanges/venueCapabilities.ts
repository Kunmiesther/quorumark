/**
 * VENUE CAPABILITIES — pure lookup, no I/O.
 *
 * Answers a single safety question: does this venue/account allow a
 * simultaneous long + short in the same symbol without netting the two
 * legs against each other?
 *
 * Consumed by `src/lib/paper/dualDirectionGate.ts`. NEVER used for
 * detection — Scout is venue-agnostic.
 */

export type HedgeMode =
  /** Long and short are always separate positions (always allowed). */
  | "always"
  /** Hedge mode is available per subaccount toggle. */
  | "per_subaccount"
  /** One-way / netting mode: opposite trade reduces or closes the current position. */
  | "one_way";

export interface VenueCapability {
  venue: string;
  hedgeMode: HedgeMode;
  supportsSimultaneousLongShort: boolean;
}

/**
 * PAPER — Long, Short, and Hedge are distinct role wallets seeded by
 * `ensure_paper_wallets`, so an opposite simulated Hedge position cannot net
 * the core position away.
 */
export const PAPER_VENUE: VenueCapability = {
  venue: "paper",
  hedgeMode: "always",
  supportsSimultaneousLongShort: true,
};

const VENUE_TABLE: Record<string, VenueCapability> = {
  paper: PAPER_VENUE,
  // Separate UI wallets do not establish independently netted venue accounts.
  apex_omni: {
    venue: "apex_omni",
    hedgeMode: "one_way",
    supportsSimultaneousLongShort: false,
  },
  aster: {
    venue: "aster",
    hedgeMode: "one_way",
    supportsSimultaneousLongShort: false,
  },
};

/**
 * Look up capabilities for a venue key. Unknown venues fail closed: the
 * safest assumption for an unknown venue is one-way netting.
 */
export function venueCapability(venue: string): VenueCapability {
  const found = VENUE_TABLE[venue];
  if (found) return found;
  return {
    venue,
    hedgeMode: "one_way",
    supportsSimultaneousLongShort: false,
  };
}
