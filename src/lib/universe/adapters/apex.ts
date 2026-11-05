/**
 * ApeX Omni universe adapter — real futures discovery.
 *
 * Uses the same public endpoint as `useApexMarkets` (browser hook) but
 * pulls the full metadata payload: max leverage, tick size, min qty, min
 * notional, spread/liquidity where available. Called server-side from
 * the discovery server function so the returned universe can be persisted.
 *
 * Fail-closed rules:
 *   - HTTP non-OK / parse error → health='offline', instruments=[]
 *   - Missing max leverage / tick / min qty / min notional → the eligibility
 *     filter rejects the symbol (this adapter still returns it so the UI
 *     can show WHY it was rejected).
 */
import type { UniverseAdapter, VerifiedInstrument, VerifiedUniverse } from "../types";

const ENDPOINT = "https://omni.apex.exchange/api/v3/symbols";
const TICKER_ENDPOINT = "https://omni.apex.exchange/api/v3/ticker";

/**
 * Best-effort typing for the fields we actually read. All numeric fields
 * arrive as strings from the API.
 */
interface PerpContractRaw {
  symbol?: string;
  symbolDisplayName?: string;
  crossSymbolName?: string;
  enableTrade?: boolean;
  enableDisplay?: boolean;
  enableOpenPosition?: boolean;
  maxOrderSize?: string | number;
  minOrderSize?: string | number;
  stepSize?: string | number;
  tickSize?: string | number;
  minNotional?: string | number;
  minNotionalValue?: string | number;
  maxLeverage?: string | number;
  displayMaxLeverage?: string | number;
  underlyingCurrency?: string;
  settleCurrency?: string;
  settleAssetId?: string;
  quoteCurrency?: string;
  baseTokenId?: string;
  turnover24h?: string | number;
  volume24h?: string | number;
  lastPrice?: string | number;
  markPrice?: string | number;
  indexPrice?: string | number;
  bid?: string | number;
  ask?: string | number;
}

interface TickerRaw {
  symbol?: string;
  lastPrice?: string | number;
  markPrice?: string | number;
  indexPrice?: string | number;
  turnover24h?: string | number;
  volume24h?: string | number;
}

function num(x: unknown): number | null {
  if (x == null) return null;
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x === "string") {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function splitQuote(apex: string): { base: string; quote: string } {
  const upper = apex.toUpperCase();
  for (const q of ["USDT", "USDC", "USD"]) {
    if (upper.endsWith(q) && upper.length > q.length) {
      return { base: upper.slice(0, upper.length - q.length), quote: q };
    }
  }
  return { base: upper, quote: "" };
}

/**
 * Convert one ApeX perp contract row into a VerifiedInstrument.
 * Pure — exported for unit testing without hitting the network.
 */
export function normalizeApexContract(
  raw: PerpContractRaw,
  generatedAt: number,
  ticker?: TickerRaw | null,
): VerifiedInstrument | null {
  const venueSymbol = (raw.crossSymbolName ?? raw.symbolDisplayName ?? raw.symbol ?? "")
    .toString()
    .toUpperCase();
  if (!venueSymbol) return null;
  const canonical = raw.symbol && raw.symbol.includes("-")
    ? raw.symbol.toUpperCase()
    : (() => {
        const { base, quote } = splitQuote(venueSymbol);
        return quote ? `${base}-${quote}` : "";
      })();
  if (!canonical) return null;
  const dash = canonical.indexOf("-");
  const base = raw.baseTokenId ?? canonical.slice(0, dash);
  const quote = raw.settleAssetId ?? raw.quoteCurrency ?? canonical.slice(dash + 1);

  const bid = num(raw.bid);
  const ask = num(raw.ask);
  const mid = bid != null && ask != null && bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  const spreadBps =
    bid != null && ask != null && mid != null && mid > 0
      ? ((ask - bid) / mid) * 10_000
      : null;

  const turnover = num(ticker?.turnover24h) ?? num(raw.turnover24h);
  const volume = num(ticker?.volume24h) ?? num(raw.volume24h);
  const lastPrice =
    num(ticker?.lastPrice) ??
    num(ticker?.markPrice) ??
    num(ticker?.indexPrice) ??
    num(raw.lastPrice) ??
    num(raw.markPrice) ??
    num(raw.indexPrice);
  const volume24hUsd =
    turnover != null
      ? turnover
      : volume != null && lastPrice != null
        ? volume * lastPrice
        : null;

  const tradable =
    raw.enableTrade !== false && raw.enableDisplay !== false && raw.enableOpenPosition !== false;

  const maxLeverage = num(raw.displayMaxLeverage) ?? num(raw.maxLeverage);
  const minQty = num(raw.minOrderSize) ?? num(raw.stepSize);
  const explicitMinNotional = num(raw.minNotional) ?? num(raw.minNotionalValue);
  const derivedMinNotional =
    explicitMinNotional ?? (minQty != null && lastPrice != null ? minQty * lastPrice : null);

  return {
    symbol: canonical,
    venueSymbol,
    base,
    quote,
    tradable,
    maxLeverage,
    tickSize: num(raw.tickSize),
    minQty,
    minNotional: derivedMinNotional,
    volume24hUsd,
    spreadBps,
    ageMs: Math.max(0, Date.now() - generatedAt),
  };
}

interface ApexEnvelope {
  data?: { contractConfig?: { perpetualContract?: PerpContractRaw[] } };
}

/**
 * Live HTTP discovery. Runs in the server worker; callers that already have
 * the raw response should use `normalizeApexUniverse` directly.
 */
export const apexOmniAdapter: UniverseAdapter = {
  exchange: "apex_omni",
  adapterVersion: 2,
  async discover({ environment, marketType, now }) {
    const generatedAt = now ?? Date.now();
    try {
      const res = await fetch(ENDPOINT, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        return offlineUniverse(environment, marketType, generatedAt, `http_${res.status}`);
      }
      const body: unknown = await res.json();
      const rows = (body as ApexEnvelope)?.data?.contractConfig?.perpetualContract ?? [];
      const venueSymbols = Array.from(
        new Set(
          rows
            .map((r) => (r.crossSymbolName ?? r.symbolDisplayName ?? "").toString().toUpperCase())
            .filter((s) => s.length > 0),
        ),
      );
      const tickerMap = await fetchTickers(venueSymbols);
      return normalizeApexUniverse(
        body as ApexEnvelope,
        environment,
        marketType,
        generatedAt,
        tickerMap,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : "fetch_error";
      return offlineUniverse(environment, marketType, generatedAt, reason);
    }
  },
};

/**
 * Fetch per-symbol tickers in parallel (bounded concurrency). ApeX Omni has
 * no batch ticker endpoint; each call returns volume/turnover for one
 * venue-symbol. Failures degrade gracefully (missing ticker → symbol lacks
 * volume and will be rejected by eligibility).
 */
async function fetchTickers(venueSymbols: string[]): Promise<Map<string, TickerRaw>> {
  const out = new Map<string, TickerRaw>();
  const CONCURRENCY = 16;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, venueSymbols.length) }, async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= venueSymbols.length) return;
      const sym = venueSymbols[idx];
      try {
        const r = await fetch(`${TICKER_ENDPOINT}?symbol=${sym}`, {
          headers: { accept: "application/json" },
        });
        if (!r.ok) continue;
        const j = (await r.json()) as { data?: TickerRaw[] };
        const row = Array.isArray(j?.data) ? j.data[0] : null;
        if (row) out.set(sym, row);
      } catch {
        /* skip */
      }
    }
  });
  await Promise.all(workers);
  return out;
}

export function normalizeApexUniverse(
  body: ApexEnvelope,
  environment: VerifiedUniverse["environment"],
  marketType: VerifiedUniverse["marketType"],
  generatedAt: number,
  tickers?: Map<string, TickerRaw>,
): VerifiedUniverse {
  const rows = body?.data?.contractConfig?.perpetualContract ?? [];
  const instruments: VerifiedInstrument[] = [];
  const seen = new Set<string>();
  let enriched = 0;
  for (const raw of rows) {
    const venue = (raw.crossSymbolName ?? raw.symbolDisplayName ?? "").toString().toUpperCase();
    const t = tickers?.get(venue) ?? null;
    if (t) enriched += 1;
    const inst = normalizeApexContract(raw, generatedAt, t);
    if (!inst) continue;
    if (seen.has(inst.symbol)) continue;
    seen.add(inst.symbol);
    instruments.push(inst);
  }
  return {
    exchange: "apex_omni",
    environment,
    marketType,
    adapterVersion: apexOmniAdapter.adapterVersion,
    capabilityVersion: 1,
    health: instruments.length > 0 ? "healthy" : "offline",
    instruments,
    detail: {
      endpoint: ENDPOINT,
      rows_seen: rows.length,
      tickers_enriched: enriched,
    },
    generatedAt,
  };
}

function offlineUniverse(
  environment: VerifiedUniverse["environment"],
  marketType: VerifiedUniverse["marketType"],
  generatedAt: number,
  reason: string,
): VerifiedUniverse {
  return {
    exchange: "apex_omni",
    environment,
    marketType,
    adapterVersion: apexOmniAdapter.adapterVersion,
    capabilityVersion: 1,
    health: "offline",
    instruments: [],
    detail: { endpoint: ENDPOINT, reason },
    generatedAt,
  };
}
