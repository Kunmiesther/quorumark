/**
 * Bounded market-data wrapper. SIMULATION READ-ONLY.
 *
 * Phase 4A: wraps `fetchApexKlines` with an explicit wall-clock timeout and a
 * typed sanitized failure result. Provider selection and price semantics are
 * intentionally unchanged — this module only adds a bound and a discriminated
 * return type so callers can never confuse "no data" with "empty candles".
 */
import { fetchApexKlines, type FetchedFeed } from "./feed";

export const DEFAULT_MARKET_TIMEOUT_MS = 5_000;

export type MarketFailureReason =
  | "timeout"
  | "network"
  | "bad_envelope"
  | "empty"
  | "aborted";

export type MarketResult =
  | { ok: true; feed: FetchedFeed }
  | { ok: false; reason: MarketFailureReason; elapsedMs: number };

interface FetchOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Injectable for tests. Defaults to real ApeX fetch. */
  fetcher?: (
    displaySymbol: string,
    intervalMin: number,
    limit: number,
    tickOverride?: number,
  ) => Promise<FetchedFeed>;
}

function classifyError(err: unknown): MarketFailureReason {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/bad envelope|no rows|gap or dup/i.test(msg)) return "bad_envelope";
  if (/HTTP/i.test(msg)) return "network";
  return "network";
}

/**
 * Fetch candles with a bounded wall-clock. Never throws — always returns a
 * discriminated `MarketResult`. Price/tick/completed-candle semantics come
 * verbatim from `fetchApexKlines`; no additional filtering is applied here.
 */
export async function fetchCandlesBounded(
  displaySymbol: string,
  intervalMin: number,
  limit: number,
  tickOverride?: number,
  opts: FetchOpts = {},
): Promise<MarketResult> {
  const timeoutMs = Math.max(1, opts.timeoutMs ?? DEFAULT_MARKET_TIMEOUT_MS);
  const fetcher = opts.fetcher ?? fetchApexKlines;
  const startedAt = Date.now();

  if (opts.signal?.aborted) {
    return { ok: false, reason: "aborted", elapsedMs: 0 };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<MarketResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({ ok: false, reason: "timeout", elapsedMs: Date.now() - startedAt });
    }, timeoutMs);
  });

  const workPromise = (async (): Promise<MarketResult> => {
    try {
      const feed = await fetcher(displaySymbol, intervalMin, limit, tickOverride);
      if (!feed || !Array.isArray(feed.candles) || feed.candles.length === 0) {
        return { ok: false, reason: "empty", elapsedMs: Date.now() - startedAt };
      }
      return { ok: true, feed };
    } catch (err) {
      return { ok: false, reason: classifyError(err), elapsedMs: Date.now() - startedAt };
    }
  })();

  try {
    return await Promise.race([workPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
