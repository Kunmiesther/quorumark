/**
 * KrakenSpotVenue — public REST ticker (verified reachable from this env, see
 * ARBITER v2 report). Kraken has its own symbol namespace (XBTUSD instead of
 * BTC-USDT); a small translation table covers the majors used by the paper
 * roster; unknown symbols return null (adapter never fabricates a price).
 *
 * supportsShort=false — spot without a borrow book cannot hold a short leg.
 * Harvester uses Kraken as the LONG hedge only.
 */
import type { VenueAdapter } from "./VenueAdapter";
import { VENUES } from "../parityConstants";

const CFG = VENUES.kraken_spot;

const SYMBOL_MAP: Record<string, string> = {
  "BTC-USDT": "XBTUSDT",
  "ETH-USDT": "ETHUSDT",
  "SOL-USDT": "SOLUSDT",
  "XRP-USDT": "XRPUSDT",
  "DOGE-USDT": "XDGUSDT",
  "ADA-USDT": "ADAUSDT",
  "AVAX-USDT": "AVAXUSDT",
  "LINK-USDT": "LINKUSDT",
  "MATIC-USDT": "MATICUSDT",
  "DOT-USDT": "DOTUSDT",
};

function translate(symbol: string): string | null {
  return SYMBOL_MAP[symbol] ?? null;
}

export class KrakenSpotVenue implements VenueAdapter {
  readonly venueId = "kraken_spot";
  readonly kind = "cex_spot" as const;
  readonly takerFeeBps = CFG.taker_bps;
  readonly makerFeeBps = CFG.maker_bps;
  readonly supportsShort = false;
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async getPrice(symbol: string): Promise<number | null> {
    const pair = translate(symbol);
    if (!pair) return null;
    const url = `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(pair)}`;
    try {
      const res = await this.fetchImpl(url);
      if (!res.ok) return null;
      const body = (await res.json()) as {
        error?: unknown[];
        result?: Record<string, { c?: [string, string] }>;
      };
      if (Array.isArray(body.error) && body.error.length > 0) return null;
      const result = body.result ?? {};
      // Kraken returns a single-entry map keyed by its canonical pair name
      // (may differ from the requested pair, e.g. XXBTZUSD for XBTUSD).
      const firstKey = Object.keys(result)[0];
      if (!firstKey) return null;
      const last = Number(result[firstKey]?.c?.[0]);
      return Number.isFinite(last) && last > 0 ? last : null;
    } catch {
      return null;
    }
  }

  estSlippageBps(_notional: number): number {
    return CFG.est_slippage_bps;
  }
}
