/**
 * VenueAdapter — the venue-abstraction interface every current and future
 * exchange (CEX perp, CEX spot, DEX perp, DEX spot) must implement.
 *
 * Arbiter v2 strategy code consumes ONLY this interface — never a raw feed.
 * That is the "build upon it" requirement: adding a new venue (OKX, BTCC,
 * a Solana DEX, etc.) is: implement adapter → register in venues/index.ts
 * → done. Zero changes to harvester / rotator / spreadArb logic.
 *
 * Deterministic contract:
 *   - getPrice / getFundingRate return the freshest fetched value or null.
 *     Adapters MUST NOT fabricate data; a null propagates as "no signal".
 *   - takerFeeBps / makerFeeBps are per-side bps for one leg fill.
 *   - estSlippageBps(notional) returns expected fill slippage vs mid for
 *     the given notional in USD. Baseline adapters use a flat value from
 *     shared/mainnet_parity_constants.json → venues.*.est_slippage_bps;
 *     future adapters may override with a size-sensitive model.
 *   - supportsShort marks whether the venue allows a short leg (spot venues
 *     without a borrow book return false → harvester will only place the
 *     LONG leg on that venue).
 */

export type VenueKind = "cex_perp" | "cex_spot" | "dex_perp" | "dex_spot";

export interface VenueAdapter {
  readonly venueId: string;
  readonly kind: VenueKind;
  /** Bps per fill on the taker side (one leg, one side). */
  readonly takerFeeBps: number;
  /** Bps per fill on the maker side (one leg, one side). */
  readonly makerFeeBps: number;
  /** Whether this venue can hold a short-side position for the hedge leg. */
  readonly supportsShort: boolean;
  /**
   * Freshest price for the symbol (in the venue's native symbol space; the
   * adapter is responsible for symbol translation).
   * Returns null when no fresh price is available.
   */
  getPrice(symbol: string): Promise<number | null>;
  /**
   * Current + predicted funding rate for a perp symbol. Undefined on venues
   * that don't have funding (spot). Returns null when the funding feed is
   * unreachable.
   */
  getFundingRate?(symbol: string): Promise<{
    fundingRate: number;
    predictedFundingRate: number;
    nextFundingTimeMs: number | null;
  } | null>;
  /** Expected slippage in bps for a market fill of the given USD notional. */
  estSlippageBps(notional: number): number;
}
