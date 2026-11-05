/**
 * SyntheticSpotVenue — deterministic offline fallback used when a real spot
 * venue's public feed is unreachable from the runtime (e.g. Kraken blocked in
 * a hosted region). Mirrors a reference perp venue's price with a configurable
 * basis offset (bps). Fees model matches shared config.
 *
 * When this is the ONLY spot venue registered, Module 5 (spreadArb) is
 * automatically disabled by the registry — no synthetic divergence to exploit.
 */
import type { VenueAdapter } from "./VenueAdapter";
import { VENUES } from "../parityConstants";

const CFG = VENUES.synthetic_spot;

export class SyntheticSpotVenue implements VenueAdapter {
  readonly venueId = "synthetic_spot";
  readonly kind = "cex_spot" as const;
  readonly takerFeeBps = CFG.taker_bps;
  readonly makerFeeBps = CFG.maker_bps;
  readonly supportsShort = false;
  readonly basisOffsetBps: number;
  private readonly reference: VenueAdapter;

  constructor(reference: VenueAdapter, basisOffsetBps: number = CFG.basis_offset_bps) {
    this.reference = reference;
    this.basisOffsetBps = basisOffsetBps;
  }

  async getPrice(symbol: string): Promise<number | null> {
    const px = await this.reference.getPrice(symbol);
    if (px === null) return null;
    return px * (1 + this.basisOffsetBps / 10_000);
  }

  estSlippageBps(_notional: number): number {
    return CFG.est_slippage_bps;
  }
}
