/**
 * BYDFi capability + instrument normalization (pure).
 *
 * BYDFi endpoints referenced (official docs — developers.bydfi.com):
 *   Public:  GET /v1/fapi/market/exchange_info  → instrument metadata
 *   Private: GET /v1/account/assets             → authenticated balance read
 *
 * These normalizers accept the raw parsed JSON blobs and return safe DTOs.
 * They never throw — malformed fields become null so the state machine can
 * fail closed at a higher layer.
 */

import type { VerifiedInstrument } from "@/lib/universe/types";

export interface BydfiAccountIdentity {
  /** Whether authenticated read succeeded (asset endpoint returned 2xx). */
  authOk: boolean;
  /** Number of asset balances returned (safe scalar). */
  assetCount: number;
  /** True when the response permission fields explicitly allow withdrawal. */
  withdrawalPermitted: boolean | null;
  /** True when we can positively confirm withdrawal is NOT enabled. */
  withdrawalDisabledVerified: boolean;
  /** True when the response permission fields allow trading. */
  tradePermitted: boolean | null;
  /** Free-form (safe, non-secret) provider account label / status. */
  status: string | null;
}

export function normalizeAccountAssets(raw: unknown): BydfiAccountIdentity {
  const root = (raw ?? {}) as Record<string, unknown>;
  const data = (root.data ?? root.result ?? root) as Record<string, unknown>;
  const list = Array.isArray((data as { assets?: unknown }).assets)
    ? ((data as { assets: unknown[] }).assets)
    : Array.isArray(data)
      ? (data as unknown[])
      : [];
  // Permission flags are not part of /account/assets in BYDFi's public docs;
  // treat them as "unverified via this endpoint" and require an explicit
  // owner confirmation upstream. This is intentionally conservative.
  return {
    authOk: true,
    assetCount: list.length,
    withdrawalPermitted: null,
    withdrawalDisabledVerified: false,
    tradePermitted: null,
    status: typeof (data as { status?: unknown }).status === "string"
      ? (data as { status: string }).status
      : null,
  };
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Convert a BYDFi native futures symbol (BTCUSDT) to Scout canonical BTC-USDT. */
export function canonicaliseBydfiSymbol(venue: string): string | null {
  if (typeof venue !== "string" || !venue) return null;
  const s = venue.toUpperCase();
  const quotes = ["USDT", "USDC", "USD"];
  for (const q of quotes) {
    if (s.endsWith(q) && s.length > q.length) {
      return `${s.slice(0, -q.length)}-${q}`;
    }
  }
  return null;
}

export function normalizeExchangeInfo(
  raw: unknown,
  generatedAt: number,
): VerifiedInstrument[] {
  const root = (raw ?? {}) as Record<string, unknown>;
  const data = (root.data ?? root.result ?? root) as Record<string, unknown>;
  const symbols = Array.isArray((data as { symbols?: unknown }).symbols)
    ? ((data as { symbols: unknown[] }).symbols)
    : Array.isArray(data)
      ? (data as unknown[])
      : [];
  const out: VerifiedInstrument[] = [];
  for (const s of symbols) {
    if (!s || typeof s !== "object") continue;
    const row = s as Record<string, unknown>;
    const venueSymbol = typeof row.symbol === "string" ? row.symbol : null;
    if (!venueSymbol) continue;
    const canonical = canonicaliseBydfiSymbol(venueSymbol);
    if (!canonical) continue;
    const [base, quote] = canonical.split("-");
    const status = typeof row.status === "string" ? row.status.toUpperCase() : "";
    const tradable = status === "" || status === "TRADING" || status === "ENABLED";
    out.push({
      symbol: canonical,
      venueSymbol,
      base: base ?? "",
      quote: quote ?? "USDT",
      tradable,
      maxLeverage: toNum(row.maxLeverage ?? row.max_leverage),
      tickSize: toNum(row.tickSize ?? row.tick_size ?? row.pricePrecision),
      minQty: toNum(row.minQty ?? row.min_qty ?? row.minTradeQty),
      minNotional: toNum(row.minNotional ?? row.min_notional),
      volume24hUsd: toNum(row.quoteVolume ?? row.volume24h ?? row.turnover24h),
      spreadBps: null,
      ageMs: 0,
    });
    void generatedAt;
  }
  return out;
}
