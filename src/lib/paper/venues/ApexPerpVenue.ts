/**
 * ApexPerpVenue — wraps the existing ApeX Omni public feed as a VenueAdapter.
 *
 * Symbol translation: Arbiter uses the canonical dashed form ("BTC-USDT"); ApeX
 * REST expects the plain form ("BTCUSDT"). The adapter normalizes on the way in.
 * Price source reuses the same /api/v3/ticker endpoint that ships the funding
 * rate — one round trip returns both fields.
 */
import type { VenueAdapter } from "./VenueAdapter";
import { VENUES } from "../parityConstants";

const CFG = VENUES.apex_perp;

function toPlain(symbol: string): string {
  return symbol.replace(/-/g, "");
}

async function fetchTicker(
  symbol: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | null> {
  const url = `https://omni.apex.exchange/api/v3/ticker?symbol=${encodeURIComponent(toPlain(symbol))}`;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    return body?.data?.[0] ?? null;
  } catch {
    return null;
  }
}

export class ApexPerpVenue implements VenueAdapter {
  readonly venueId = "apex_perp";
  readonly kind = "cex_perp" as const;
  readonly takerFeeBps = CFG.taker_bps;
  readonly makerFeeBps = CFG.maker_bps;
  readonly supportsShort = true;
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async getPrice(symbol: string): Promise<number | null> {
    const row = await fetchTicker(symbol, this.fetchImpl);
    if (!row) return null;
    const px = Number(row.lastPrice ?? row.markPrice ?? row.indexPrice);
    return Number.isFinite(px) && px > 0 ? px : null;
  }

  async getFundingRate(symbol: string) {
    const row = await fetchTicker(symbol, this.fetchImpl);
    if (!row) return null;
    const rate = Number(row.fundingRate);
    const pred = Number(row.predictedFundingRate);
    if (!Number.isFinite(rate) || !Number.isFinite(pred)) return null;
    const nextIso = typeof row.nextFundingTime === "string" ? row.nextFundingTime : null;
    const next = nextIso ? Date.parse(nextIso) : NaN;
    return {
      fundingRate: rate,
      predictedFundingRate: pred,
      nextFundingTimeMs: Number.isFinite(next) ? next : null,
    };
  }

  estSlippageBps(_notional: number): number {
    // Baseline flat model per shared config. Future adapters may implement a
    // size-sensitive book-depth walker.
    return CFG.est_slippage_bps;
  }
}
