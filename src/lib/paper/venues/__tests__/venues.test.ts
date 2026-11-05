import { describe, it, expect } from "vitest";
import type { VenueAdapter } from "@/lib/paper/venues";
import {
  ApexPerpVenue,
  KrakenSpotVenue,
  SyntheticSpotVenue,
  buildDefaultRegistry,
  buildFallbackRegistry,
  spreadArbEligible,
} from "@/lib/paper/venues";

// Every adapter must satisfy the contract: id, kind, non-negative fees,
// getPrice returning a number|null (never undefined), estSlippageBps >= 0.
async function runAdapterContract(adapter: VenueAdapter) {
  expect(typeof adapter.venueId).toBe("string");
  expect(adapter.venueId.length).toBeGreaterThan(0);
  expect(["cex_perp", "cex_spot", "dex_perp", "dex_spot"]).toContain(adapter.kind);
  expect(adapter.takerFeeBps).toBeGreaterThanOrEqual(0);
  expect(adapter.makerFeeBps).toBeGreaterThanOrEqual(0);
  expect(typeof adapter.supportsShort).toBe("boolean");
  expect(adapter.estSlippageBps(1_000)).toBeGreaterThanOrEqual(0);
  // getPrice must be callable and return a number|null. Use a fake fetch
  // to keep the test deterministic and network-free.
  const px = await adapter.getPrice("BTC-USDT");
  expect(px === null || typeof px === "number").toBe(true);
}

const okFetch = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

const failFetch: typeof fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;

describe("VenueAdapter contract", () => {
  it("ApexPerpVenue satisfies the contract", async () => {
    await runAdapterContract(
      new ApexPerpVenue(
        okFetch({
          data: [{ lastPrice: "60000", fundingRate: "0.0001", predictedFundingRate: "0.0001", nextFundingTime: "2026-07-24T08:00:00Z" }],
        }),
      ),
    );
  });

  it("KrakenSpotVenue satisfies the contract", async () => {
    await runAdapterContract(
      new KrakenSpotVenue(okFetch({ error: [], result: { XXBTZUSDT: { c: ["60005", "0.1"] } } })),
    );
  });

  it("SyntheticSpotVenue satisfies the contract and mirrors reference with offset", async () => {
    const ref = new ApexPerpVenue(okFetch({ data: [{ lastPrice: "100" }] }));
    const syn = new SyntheticSpotVenue(ref, 25); // +25 bps
    await runAdapterContract(syn);
    const px = await syn.getPrice("BTC-USDT");
    expect(px).toBeCloseTo(100 * 1.0025, 8);
  });

  it("Adapters return null (not undefined) on feed failure — never fabricate", async () => {
    const apex = new ApexPerpVenue(failFetch);
    expect(await apex.getPrice("BTC-USDT")).toBeNull();
    const funding = await apex.getFundingRate!("BTC-USDT");
    expect(funding).toBeNull();

    const kraken = new KrakenSpotVenue(failFetch);
    expect(await kraken.getPrice("BTC-USDT")).toBeNull();
    // Unknown symbol → null translation
    expect(await kraken.getPrice("UNKNOWN-USDT")).toBeNull();
  });
});

describe("Venue registry", () => {
  it("default registry contains apex_perp + kraken_spot, ordered by venueId", () => {
    const reg = buildDefaultRegistry();
    expect(reg.venues.map((v) => v.venueId)).toEqual(["apex_perp", "kraken_spot"]);
    expect(reg.get("apex_perp")?.kind).toBe("cex_perp");
    expect(reg.fundingVenues().map((v) => v.venueId)).toEqual(["apex_perp"]);
  });

  it("pairs() yields ordered unique venue pairs", () => {
    const reg = buildDefaultRegistry();
    const pairs = reg.pairs();
    expect(pairs.length).toBe(1);
    expect(pairs[0][0].venueId).toBe("apex_perp");
    expect(pairs[0][1].venueId).toBe("kraken_spot");
  });

  it("spreadArbEligible is true for default (Apex+Kraken), false for Synthetic fallback", () => {
    expect(spreadArbEligible(buildDefaultRegistry())).toBe(true);
    expect(spreadArbEligible(buildFallbackRegistry())).toBe(false);
  });
});
