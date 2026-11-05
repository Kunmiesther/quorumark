/**
 * Batched, coalesced, TTL-bounded market-data cache for Scout.
 *
 * Read-only public data (ApeX Omni klines). NEVER a write path.
 *
 * - One in-flight fetch per (symbol, tf) key; concurrent callers share.
 * - Per-TF TTL from types.ts.
 * - 8s per-request timeout, 1 retry with 200-800ms jitter.
 * - Per-symbol failure isolation via Promise.allSettled at higher layers.
 * - Native ApeX intervals: 5, 15, 60, 240, D. Weekly / Monthly aggregated
 *   deterministically from completed daily candles.
 */
import type { Candle } from "@/lib/paper/signal";
import { aggregateMonthly, aggregateWeekly } from "./aggregate";
import { TIMEFRAME_TTL_MS, type Timeframe } from "./types";

// ApeX Omni supports native intervals for all seven Scout timeframes.
// NOTE: the endpoint silently returns `{data:{}}` when `limit > 200`, so every
// call site MUST cap `limit` at 200 — see `MAX_APEX_LIMIT`.
const NATIVE_APEX_INTERVAL: Record<Timeframe, string> = {
  M5: "5",
  M15: "15",
  H1: "60",
  H4: "240",
  D: "D",
  W: "W",
  M: "M",
};

const MAX_APEX_LIMIT = 200;

const REQUEST_TIMEOUT_MS = 8_000;

function toApexSymbol(symbol: string): string {
  return symbol.replace(/[-_/]/g, "").toUpperCase();
}

interface ApexKline {
  t?: number | string;
  o?: number | string;
  h?: number | string;
  l?: number | string;
  c?: number | string;
  v?: number | string;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function parseCandles(apexSym: string, body: unknown): Candle[] {
  let rows: ApexKline[] = [];
  if (body && typeof body === "object") {
    const data = (body as { data?: unknown }).data;
    if (Array.isArray(data)) rows = data as ApexKline[];
    else if (data && typeof data === "object") {
      const byKey = (data as Record<string, unknown>)[apexSym];
      if (Array.isArray(byKey)) rows = byKey as ApexKline[];
      else {
        for (const v of Object.values(data as Record<string, unknown>)) {
          if (Array.isArray(v)) {
            rows = v as ApexKline[];
            break;
          }
        }
      }
    } else if (Array.isArray(body)) rows = body as ApexKline[];
  }
  return rows
    .map<Candle | null>((r) => {
      const t = num(r.t),
        o = num(r.o),
        h = num(r.h),
        l = num(r.l),
        c = num(r.c),
        v = num(r.v);
      if (!Number.isFinite(t) || !Number.isFinite(c)) return null;
      return [t, o, h, l, c, Number.isFinite(v) ? v : 0];
    })
    .filter((c): c is Candle => c !== null)
    .sort((a, b) => a[0] - b[0]);
}

/** Drop the currently-forming (open) candle if present. */
function keepClosed(candles: Candle[], tfMs: number, now: number): Candle[] {
  return candles.filter((c) => c[0] + tfMs <= now);
}

const TF_NATIVE_MS: Record<Timeframe, number> = {
  M5: 5 * 60 * 1000,
  M15: 15 * 60 * 1000,
  H1: 60 * 60 * 1000,
  H4: 4 * 60 * 60 * 1000,
  D: 24 * 60 * 60 * 1000,
  // Approximate — only used for `keepClosed` guard on the currently-forming bucket.
  W: 7 * 24 * 60 * 60 * 1000,
  M: 30 * 24 * 60 * 60 * 1000,
};

async function fetchNativeApex(
  symbol: string,
  tf: Timeframe,
  limit: number,
  fetchImpl: typeof fetch,
  now = Date.now(),
): Promise<Candle[]> {
  const apexSym = toApexSymbol(symbol);
  const interval = NATIVE_APEX_INTERVAL[tf];
  // Hard cap: ApeX returns empty `data` when limit exceeds 200.
  const safeLimit = Math.min(Math.max(1, limit), MAX_APEX_LIMIT);
  const url = `https://omni.apex.exchange/api/v3/klines?symbol=${apexSym}&interval=${interval}&limit=${safeLimit}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // Surface HTTP status so retry logic can escalate backoff on 429/5xx.
      const err = new Error(`ApeX ${tf} ${symbol} HTTP ${res.status}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    const body = (await res.json()) as unknown;
    return keepClosed(parseCandles(apexSym, body), TF_NATIVE_MS[tf], now);
  } finally {
    clearTimeout(timer);
  }
}

interface CacheEntry {
  candles: Candle[];
  fetchedAt: number;
}

export interface MarketCache {
  getCandles(symbol: string, tf: Timeframe, now?: number): Promise<Candle[]>;
  clear(): void;
  /** Testing / diagnostics. */
  size(): number;
}

interface CreateOptions {
  fetchImpl?: typeof fetch;
  /** Override TTLs for tests. */
  ttls?: Partial<Record<Timeframe, number>>;
}

export function createMarketCache(opts: CreateOptions = {}): MarketCache {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ttls = { ...TIMEFRAME_TTL_MS, ...opts.ttls };
  const store = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<Candle[]>>();

  async function fetchWithRetry(
    symbol: string,
    tf: Timeframe,
    limit: number,
    now: number,
  ): Promise<Candle[]> {
    try {
      return await fetchNativeApex(symbol, tf, limit, fetchImpl, now);
    } catch (err) {
      // Rate-limit-aware backoff: HTTP 429 and 5xx get a longer wait so a
      // wide-universe fan-out doesn't hammer the venue on the first retry.
      const status = (err as { status?: number })?.status;
      const isRateLimited = status === 429 || (status != null && status >= 500);
      const base = isRateLimited ? 1_000 : 200;
      const jitter = base + Math.floor(Math.random() * 600);
      await new Promise((r) => setTimeout(r, jitter));
      return fetchNativeApex(symbol, tf, limit, fetchImpl, now);
    }
  }

  async function primeDaily(symbol: string, now: number): Promise<Candle[]> {
    const key = `${symbol}:D`;
    const cached = store.get(key);
    if (cached && now - cached.fetchedAt < ttls.D) return cached.candles;
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = fetchWithRetry(symbol, "D", MAX_APEX_LIMIT, now).then((candles) => {
      store.set(key, { candles, fetchedAt: now });
      inflight.delete(key);
      return candles;
    }).catch((err) => {
      inflight.delete(key);
      throw err;
    });
    inflight.set(key, p);
    return p;
  }

  async function getCandles(symbol: string, tf: Timeframe, now = Date.now()): Promise<Candle[]> {
    const key = `${symbol}:${tf}`;
    const cached = store.get(key);
    if (cached && now - cached.fetchedAt < ttls[tf]) return cached.candles;
    const existing = inflight.get(key);
    if (existing) return existing;

    // Prefer native ApeX intervals for all timeframes (W/M supported natively).
    // If a native fetch returns too few candles for W/M, fall back to deterministic
    // aggregation from completed daily candles.
    let p: Promise<Candle[]>;
    if (tf === "W" || tf === "M") {
      p = fetchWithRetry(symbol, tf, MAX_APEX_LIMIT, now).then(async (native) => {
        // A healthy weekly/monthly needs enough history for downstream EMAs;
        // if the exchange history is thin, augment with aggregation.
        const minNative = tf === "W" ? 30 : 10;
        if (native.length >= minNative) {
          store.set(key, { candles: native, fetchedAt: now });
          inflight.delete(key);
          return native;
        }
        try {
          const daily = await primeDaily(symbol, now);
          const agg = tf === "W" ? aggregateWeekly(daily, now) : aggregateMonthly(daily, now);
          const result = agg.length > native.length ? agg : native;
          store.set(key, { candles: result, fetchedAt: now });
          inflight.delete(key);
          return result;
        } catch {
          store.set(key, { candles: native, fetchedAt: now });
          inflight.delete(key);
          return native;
        }
      });
    } else {
      p = fetchWithRetry(symbol, tf, MAX_APEX_LIMIT, now).then((candles) => {
        store.set(key, { candles, fetchedAt: now });
        inflight.delete(key);
        return candles;
      });
    }
    p = p.catch((err) => {
      inflight.delete(key);
      throw err;
    });
    inflight.set(key, p);
    return p;
  }

  return {
    getCandles,
    clear() {
      store.clear();
      inflight.clear();
    },
    size() {
      return store.size;
    },
  };
}


/** Process-scoped default cache — used by the scan server function. */
let _shared: MarketCache | null = null;
export function sharedMarketCache(): MarketCache {
  if (!_shared) _shared = createMarketCache();
  return _shared;
}
