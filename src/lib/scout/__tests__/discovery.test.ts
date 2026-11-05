import { describe, expect, it, vi } from "vitest";
import { discoveryRequestSchema, filterDiscovery, normalizeDiscovery } from "../discovery";
import { createDiscoveryClient } from "../discovery.server";

const address = "0x1111111111111111111111111111111111111111";
const base = { address, symbol: "ETH", name: "Not necessarily Ether" };
const row = {
  chainId: "base",
  pairAddress: address,
  dexId: "uniswap",
  baseToken: base,
  quoteToken: { ...base, symbol: "USDC" },
  priceUsd: "0.001",
  liquidity: { usd: 100 },
  volume: { h24: 50 },
  priceChange: { h24: -2 },
  txns: { h24: { buys: 4, sells: 2 } },
  pairCreatedAt: 1000,
};
const input = { chain: "base" as const, query: "ETH" };
const response = () => new Response(JSON.stringify({ pairs: [row] }), { status: 200 });

describe("DEX Screener discovery contract", () => {
  it("restricts chains, query sizes, markup and extra URLs", () => {
    expect(discoveryRequestSchema.safeParse({ ...input, chain: "robinhood" }).success).toBe(false);
    expect(discoveryRequestSchema.safeParse({ ...input, query: "<img src=x>" }).success).toBe(
      false,
    );
    expect(discoveryRequestSchema.safeParse({ ...input, query: "a".repeat(101) }).success).toBe(
      false,
    );
    expect(
      discoveryRequestSchema.safeParse({ ...input, url: "https://evil.example" }).success,
    ).toBe(false);
  });
  it("uses contracts not ticker or paid boosts for identity", () => {
    const other = "0x2222222222222222222222222222222222222222";
    const pairs = normalizeDiscovery(
      [
        row,
        row,
        {
          ...row,
          pairAddress: other,
          baseToken: { ...base, address: other },
          boosts: { active: 10000 },
        },
      ],
      "base",
      10000,
    );
    expect(pairs).toHaveLength(2);
    expect(pairs[1].base.address).toBe(other);
    expect(pairs[1]).not.toHaveProperty("boosts");
  });
  it("drops wrong-chain and invalid-address pools and ignores untrusted URLs", () => {
    const pairs = normalizeDiscovery(
      [
        { ...row, chainId: "bsc" },
        { ...row, pairAddress: "bad" },
        { ...row, url: "javascript:bad", info: { imageUrl: "https://evil.example/logo.png" } },
      ],
      "base",
      10000,
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].url).toBe(`https://dexscreener.com/base/${address}`);
    expect(pairs[0].image).toBeNull();
  });
  it("keeps absent, invalid and future metrics unknown, but preserves zero", () => {
    const [p] = normalizeDiscovery(
      [
        {
          ...row,
          priceUsd: "",
          liquidity: null,
          volume: { h24: 0 },
          priceChange: { h24: -2 },
          txns: {},
          pairCreatedAt: 999999,
        },
      ],
      "base",
      10000,
    );
    expect(p).toMatchObject({
      price: null,
      liquidity: null,
      volume: 0,
      change: -2,
      buys: null,
      sells: null,
      createdAt: null,
    });
    expect(
      normalizeDiscovery([{ ...row, priceUsd: "NaN", liquidity: { usd: -1 } }], "base", 10000)[0]
        .liquidity,
    ).toBeNull();
  });
  it("excludes unknown metrics only when that filter is selected", () => {
    const pairs = normalizeDiscovery(
      [row, { ...row, pairAddress: "0x2222222222222222222222222222222222222222", liquidity: null }],
      "base",
      10000,
    );
    expect(
      filterDiscovery(pairs, { liquidity: 0, volume: 0, ageHours: 0, sort: "liquidity" }, 10000),
    ).toHaveLength(2);
    expect(
      filterDiscovery(pairs, { liquidity: 50, volume: 0, ageHours: 0, sort: "liquidity" }, 10000),
    ).toHaveLength(1);
    expect(
      filterDiscovery(pairs, { liquidity: 0, volume: 0, ageHours: 24, sort: "volume" }, 10000),
    ).toHaveLength(0);
  });
});

describe("discovery provider transport", () => {
  it("deduplicates requests and caches for 30 seconds", async () => {
    let now = 10000;
    const fetcher = vi.fn(async () => response());
    const search = createDiscoveryClient(fetcher, () => now);
    const [a, b] = await Promise.all([search(input), search(input)]);
    expect(a).toEqual(b);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await search(input);
    now += 30000;
    await search(input);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("uses token-pairs lookup for a contract, fixed origin and no auth secrets", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify([row])));
    await createDiscoveryClient(fetcher)({ ...input, query: address });
    expect(fetcher.mock.calls[0][0]).toBe(
      `https://api.dexscreener.com/token-pairs/v1/base/${address}`,
    );
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      headers: { Accept: "application/json" },
      redirect: "error",
    });
  });
  it("respects 429 cooldown instead of retrying in a tight loop", async () => {
    let now = 10000;
    const fetcher = vi.fn(
      async () => new Response("", { status: 429, headers: { "Retry-After": "90" } }),
    );
    const search = createDiscoveryClient(fetcher, () => now);
    await expect(search(input)).rejects.toThrow("rate-limited");
    now += 60000;
    await expect(search({ ...input, query: "BTC" })).rejects.toThrow("rate-limited");
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 30000;
    await expect(search(input)).rejects.toThrow("rate-limited");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not return expired data on provider failure", async () => {
    let now = 10000;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response())
      .mockRejectedValueOnce(new Error("private URL"));
    const search = createDiscoveryClient(fetcher, () => now);
    await search(input);
    now += 31000;
    await expect(search(input)).rejects.toThrow("could not be reached");
  });
  it("distinguishes empty results from malformed provider data", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ pairs: null })))
      .mockResolvedValueOnce(new Response("{}"));
    const search = createDiscoveryClient(fetcher);
    expect((await search(input)).pairs).toEqual([]);
    await expect(search({ ...input, query: "BTC" })).rejects.toThrow("unexpected response");
  });
  it("bounds cache size and per-instance request volume", async () => {
    const fetcher = vi.fn(async () => response());
    const search = createDiscoveryClient(fetcher, () => 10000);
    for (let n = 0; n < 101; n++) await search({ ...input, query: `token${n}` });
    await search({ ...input, query: "token0" });
    expect(fetcher).toHaveBeenCalledTimes(102);
    for (let n = 102; n < 120; n++) await search({ ...input, query: `token${n}` });
    await expect(search({ ...input, query: "limit" })).rejects.toThrow("busy");
  });
  it.skipIf(process.env.RUN_PUBLIC_DISCOVERY_CHECKS !== "1")(
    "reads real pools on Base, BNB and Solana without credentials",
    async () => {
      const search = createDiscoveryClient();
      for (const request of [
        { chain: "base" as const, query: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
        { chain: "bsc" as const, query: "0x55d398326f99059ff775485246999027b3197955" },
        { chain: "solana" as const, query: "So11111111111111111111111111111111111111112" },
      ]) {
        const result = await search(request);
        expect(result.pairs.length).toBeGreaterThan(0);
        expect(result.pairs.every((p) => p.chain === request.chain)).toBe(true);
      }
    },
    40000,
  );
});
