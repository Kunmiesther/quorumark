// Single source of truth for venue allowlist. Used by UI and any server/worker
// validation. Anything not in this list must not be selectable, initializable,
// or tradeable. Execution stays locked at the app-env layer regardless of venue.
export const SUPPORTED_CEX = ["coinbase", "kraken"] as const;
export type SupportedCex = (typeof SUPPORTED_CEX)[number];

// DEX / perp-DEX venues offered by TurtleBot.
//
// This is the product allowlist, not an assertion that every venue can execute
// live orders. Venue-specific execution readiness is established by the
// connection/readiness APIs and each venue's dedicated signer. In particular,
// Aster and SynFutures must never be routed through the ApeX signer.
//
// Testnet was removed from the customer experience. The historical testnet
// venue id ("apex_omni_testnet") is intentionally NOT part of the customer
// allowlist. Legacy DB rows with that value will fail `isSupportedVenue`
// and be filtered out of UI lists.
export const SUPPORTED_DEX = ["apex_omni", "aster", "synfutures"] as const;
export type SupportedDex = (typeof SUPPORTED_DEX)[number];

export const SUPPORTED_VENUES = [...SUPPORTED_CEX, ...SUPPORTED_DEX] as const;
export type SupportedVenue = (typeof SUPPORTED_VENUES)[number];

export type VenueKind = "cex" | "dex";

export function isSupportedCex(id: string | null | undefined): id is SupportedCex {
  if (!id) return false;
  return (SUPPORTED_CEX as readonly string[]).includes(id.toLowerCase());
}

export function isSupportedDex(id: string | null | undefined): id is SupportedDex {
  if (!id) return false;
  return (SUPPORTED_DEX as readonly string[]).includes(id.toLowerCase());
}

export function isSupportedVenue(id: string | null | undefined): id is SupportedVenue {
  return isSupportedCex(id) || isSupportedDex(id);
}

export function venueKind(id: string | null | undefined): VenueKind | null {
  if (isSupportedCex(id)) return "cex";
  if (isSupportedDex(id)) return "dex";
  return null;
}

export function isTestnetVenue(id: string | null | undefined): boolean {
  return (id ?? "").toLowerCase() === "apex_omni_testnet";
}

// Market support per venue. Orthogonal to venueKind() (custody/credential shape).
// Ground truth:
//   coinbase, kraken — CEX, spot + futures (connectors pending)
//   apex_omni, aster, synfutures — perp DEXes, NEVER spot
export type MarketSupport = "spot" | "futures" | "both";

export const VENUE_MARKETS: Record<SupportedVenue, MarketSupport> = {
  coinbase: "both",
  kraken: "both",
  apex_omni: "futures",
  aster: "futures",
  synfutures: "futures",
};

export function venueMarkets(id: string | null | undefined): MarketSupport | null {
  if (!isSupportedVenue(id)) return null;
  return VENUE_MARKETS[id.toLowerCase() as SupportedVenue];
}

export function venueSupportsMarket(
  id: string | null | undefined,
  market: "spot" | "futures",
): boolean {
  const m = venueMarkets(id);
  if (!m) return false;
  return m === "both" || m === market;
}
