import {
  discoveryRequestSchema,
  isDiscoveryAddress,
  normalizeDiscovery,
  type DiscoveryRequest,
  type DiscoveryResult,
} from "./discovery";

/** Public, read-only provider. No wallet secrets, RPC signing or execution imports. */
export function createDiscoveryClient(fetcher: typeof fetch = fetch, now = Date.now) {
  const cache = new Map<string, DiscoveryResult>();
  const pending = new Map<string, Promise<DiscoveryResult>>();
  let windowStart = now(),
    requests = 0,
    cooldownUntil = 0;
  return async (raw: DiscoveryRequest): Promise<DiscoveryResult> => {
    const input = discoveryRequestSchema.parse(raw);
    const address = isDiscoveryAddress(input);
    const q = address && input.chain !== "solana" ? input.query.toLowerCase() : input.query;
    const key = `${input.chain}:${q}`;
    const hit = cache.get(key);
    if (hit && now() - hit.fetchedAt < 30_000) return hit;
    const running = pending.get(key);
    if (running) return running;
    if (now() < cooldownUntil)
      throw new Error("DEX Screener is rate-limited. Please retry in a minute.");
    if (now() - windowStart >= 60_000) {
      windowStart = now();
      requests = 0;
    }
    // Per-instance protection, not a distributed/global provider quota guarantee.
    if (requests >= 120 || pending.size >= 8)
      throw new Error("Discovery is busy. Please retry in a minute.");
    requests++;
    const path = address
      ? `/token-pairs/v1/${input.chain}/${encodeURIComponent(q)}`
      : `/latest/dex/search?q=${encodeURIComponent(q)}`;
    const work = (async () => {
      let response: Response;
      try {
        response = await fetcher(`https://api.dexscreener.com${path}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        });
      } catch {
        throw new Error("DEX Screener could not be reached. Retry the search.");
      }
      if (response.status === 429) {
        const retry = Number(response.headers.get("Retry-After"));
        cooldownUntil =
          now() + Math.min(300, Math.max(60, Number.isFinite(retry) ? retry : 60)) * 1000;
        throw new Error("DEX Screener is rate-limited. Please retry in a minute.");
      }
      if (!response.ok) throw new Error("DEX Screener is unavailable. Retry the search.");
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new Error("DEX Screener returned unreadable data. Retry the search.");
      }
      const rows = address
        ? json
        : json && typeof json === "object"
          ? (json as { pairs?: unknown }).pairs
          : undefined;
      if (rows !== null && !Array.isArray(rows))
        throw new Error("DEX Screener returned an unexpected response.");
      const fetchedAt = now();
      const result = { pairs: normalizeDiscovery(rows ?? [], input.chain, fetchedAt), fetchedAt };
      // Do not serve a stale success when the provider fails.
      cache.delete(key);
      if (cache.size >= 100) cache.delete(cache.keys().next().value!);
      cache.set(key, result);
      return result;
    })();
    pending.set(key, work);
    try {
      return await work;
    } finally {
      pending.delete(key);
    }
  };
}
export const searchDiscovery = createDiscoveryClient();
