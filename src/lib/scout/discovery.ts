import { z } from "zod";

export const DISCOVERY_CHAINS = { base: "Base", bsc: "BNB Chain", solana: "Solana" } as const;
export const discoveryRequestSchema = z
  .object({
    chain: z.enum(["base", "bsc", "solana"]),
    query: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .regex(/^[\p{L}\p{N}\s._$:/-]+$/u, "Enter a token name, symbol or contract address."),
  })
  .strict();
export type DiscoveryRequest = z.infer<typeof discoveryRequestSchema>;
export interface DiscoveryPair {
  id: string;
  chain: DiscoveryRequest["chain"];
  dex: string;
  address: string;
  base: { address: string; name: string; symbol: string };
  quote: { address: string; name: string; symbol: string };
  url: string;
  image: string | null;
  price: number | null;
  liquidity: number | null;
  volume: number | null;
  change: number | null;
  buys: number | null;
  sells: number | null;
  createdAt: number | null;
}
export interface DiscoveryResult {
  pairs: DiscoveryPair[];
  fetchedAt: number;
}

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const label = (v: unknown) => (typeof v === "string" ? v.slice(0, 120) : "");
const metric = (v: unknown, signed = false): number | null =>
  typeof v === "number" && Number.isFinite(v) && (signed || v >= 0) ? v : null;
const addressValid = (chain: DiscoveryRequest["chain"], v: string) =>
  chain === "solana" ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) : /^0x[0-9a-fA-F]{40}$/.test(v);
export function isDiscoveryAddress(input: DiscoveryRequest) {
  return addressValid(input.chain, input.query);
}
function imageUrl(v: unknown): string | null {
  try {
    const u = new URL(String(v));
    return u.protocol === "https:" &&
      u.hostname === "cdn.dexscreener.com" &&
      !u.username &&
      !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}

/** Provider labels are untrusted; chain + contract, never ticker, identifies a token. */
export function normalizeDiscovery(
  rows: unknown[],
  chain: DiscoveryRequest["chain"],
  now: number,
): DiscoveryPair[] {
  const found = new Map<string, DiscoveryPair>();
  for (const raw of rows.slice(0, 300)) {
    const p = record(raw);
    if (p.chainId !== chain) continue;
    const address = label(p.pairAddress);
    const token = (rawToken: unknown) => {
      const t = record(rawToken);
      return { address: label(t.address), name: label(t.name), symbol: label(t.symbol) };
    };
    const base = token(p.baseToken),
      quote = token(p.quoteToken);
    if (![address, base.address, quote.address].every((a) => addressValid(chain, a))) continue;
    const canonical = chain === "solana" ? address : address.toLowerCase();
    const id = `${chain}:${canonical}`;
    const txns = record(record(p.txns).h24);
    const price =
      typeof p.priceUsd === "string" && p.priceUsd.trim()
        ? metric(Number(p.priceUsd))
        : metric(p.priceUsd);
    const created = metric(p.pairCreatedAt);
    found.set(id, {
      id,
      chain,
      dex: label(p.dexId) || "Unknown DEX",
      address,
      base,
      quote,
      url: `https://dexscreener.com/${chain}/${encodeURIComponent(address)}`,
      image: imageUrl(record(p.info).imageUrl),
      price,
      liquidity: metric(record(p.liquidity).usd),
      volume: metric(record(p.volume).h24),
      change: metric(record(p.priceChange).h24, true),
      buys: Number.isInteger(txns.buys) ? metric(txns.buys) : null,
      sells: Number.isInteger(txns.sells) ? metric(txns.sells) : null,
      createdAt: created !== null && created > 0 && created <= now ? created : null,
    });
  }
  return [...found.values()];
}

export function filterDiscovery(
  pairs: DiscoveryPair[],
  filters: { liquidity: number; volume: number; ageHours: number; sort: "liquidity" | "volume" },
  now: number,
) {
  return pairs
    .filter(
      (p) =>
        (filters.liquidity === 0 || (p.liquidity !== null && p.liquidity >= filters.liquidity)) &&
        (filters.volume === 0 || (p.volume !== null && p.volume >= filters.volume)) &&
        (filters.ageHours === 0 ||
          (p.createdAt !== null && now - p.createdAt >= filters.ageHours * 3_600_000)),
    )
    .sort((a, b) => (b[filters.sort] ?? -1) - (a[filters.sort] ?? -1) || a.id.localeCompare(b.id));
}
