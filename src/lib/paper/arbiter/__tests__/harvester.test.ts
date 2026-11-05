import { describe, it, expect } from "vitest";
import {
  projectNetApr,
  evaluateHarvest,
  buildPair,
  accrueFundingCredit,
  basisDivergence,
  legImbalanceFrac,
  evaluateHarvestExit,
} from "@/lib/paper/arbiter/harvester";
import { ApexPerpVenue, KrakenSpotVenue, SyntheticSpotVenue } from "@/lib/paper/venues";
import { ARBITER } from "@/lib/paper/parityConstants";
import type { ArbiterPair } from "@/lib/paper/arbiter/pair";

const okFetch = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

// Locally force the enabled gate for these pure-function tests.
function withEnabled<T>(fn: () => T): T {
  const prev = ARBITER.enabled;
  (ARBITER as { enabled: boolean }).enabled = true;
  try {
    return fn();
  } finally {
    (ARBITER as { enabled: boolean }).enabled = prev;
  }
}

describe("harvester — projectNetApr", () => {
  it("funding APR annualizes with 3 intervals/day × 365", () => {
    // rate 0.01% every 8h => APR = 0.0001 * 3 * 365 = 0.1095
    const b = projectNetApr({
      fundingRate: 0.0001,
      fundingIntervalHours: 8,
      perpFeeBps: 0,
      spotFeeBps: 0,
      perpSlipBps: 0,
      spotSlipBps: 0,
    });
    expect(b.fundingApr).toBeCloseTo(0.0001 * 3 * 365, 8);
    expect(b.netApr).toBeCloseTo(b.fundingApr, 8);
  });

  it("amortizes fees + slippage on BOTH legs and BOTH sides over hold window", () => {
    const b = projectNetApr({
      fundingRate: 0.001,
      fundingIntervalHours: 8,
      perpFeeBps: 5,
      spotFeeBps: 26,
      perpSlipBps: 2,
      spotSlipBps: 5,
      assumedHoldDays: 1,
    });
    // round-trip fees = (5+26)*2/10000 = 0.0062
    expect(b.roundTripFeesFrac).toBeCloseTo(0.0062, 8);
    // slippage = (2+5)*2/10000 = 0.0014
    expect(b.slippageFrac).toBeCloseTo(0.0014, 8);
    // amortization = (0.0062 + 0.0014) * 365 = 2.774
    expect(b.amortization).toBeCloseTo(0.0076 * 365, 6);
  });
});

describe("harvester — evaluateHarvest gate", () => {
  const perp = new ApexPerpVenue(okFetch({}));
  const spot = new KrakenSpotVenue(okFetch({}));

  it("blocks when arbiter disabled", () => {
    const v = evaluateHarvest({
      symbol: "BTC-USDT",
      perp,
      hedge: spot,
      fundingRate: 0.001,
      perpPrice: 60_000,
      hedgePrice: 60_000,
      fundingIntervalHours: 8,
      notionalUsd: 10_000,
    });
    expect(v.open).toBe(false);
    if (!v.open) expect(v.reason).toBe("arbiter_disabled");
  });

  it("blocks below min funding rate", () => {
    withEnabled(() => {
      const v = evaluateHarvest({
        symbol: "BTC-USDT",
        perp,
        hedge: spot,
        fundingRate: 0.0001, // below min 0.0003
        perpPrice: 60_000,
        hedgePrice: 60_000,
        fundingIntervalHours: 8,
        notionalUsd: 10_000,
      });
      expect(v.open).toBe(false);
      if (!v.open) expect(v.reason).toBe("rate_below_min");
    });
  });

  it("blocks below min net APR (fees eat the harvest)", () => {
    withEnabled(() => {
      // Just above min funding rate but too small to survive fees on both legs.
      const v = evaluateHarvest({
        symbol: "BTC-USDT",
        perp,
        hedge: spot,
        fundingRate: 0.0004,
        perpPrice: 60_000,
        hedgePrice: 60_000,
        fundingIntervalHours: 8,
        notionalUsd: 10_000,
      });
      expect(v.open).toBe(false);
      if (!v.open) expect(v.reason).toBe("net_apr_below_min");
    });
  });

  it("receiving side selection — positive rate → short receives", () => {
    withEnabled(() => {
      // Large positive rate — receiver should be short. Kraken spot cannot
      // hold a short, so the OPPOSITE (long) hedge is valid. Receiver=short.
      const v = evaluateHarvest({
        symbol: "BTC-USDT",
        perp,
        hedge: spot,
        fundingRate: 0.005,
        perpPrice: 60_000,
        hedgePrice: 60_000,
        fundingIntervalHours: 8,
        notionalUsd: 10_000,
      });
      expect(v.open).toBe(true);
      if (v.open) expect(v.candidate.direction).toBe("short");
    });
  });

  it("blocks when receiver=long would require short spot hedge (spot supportsShort=false)", () => {
    withEnabled(() => {
      const v = evaluateHarvest({
        symbol: "BTC-USDT",
        perp,
        hedge: spot,
        fundingRate: -0.005, // negative → long receives → hedge must short
        perpPrice: 60_000,
        hedgePrice: 60_000,
        fundingIntervalHours: 8,
        notionalUsd: 10_000,
      });
      expect(v.open).toBe(false);
      if (!v.open) expect(v.reason).toBe("hedge_venue_missing");
    });
  });

  it("blocks on missing hedge price (never fabricates)", () => {
    withEnabled(() => {
      const v = evaluateHarvest({
        symbol: "BTC-USDT",
        perp,
        hedge: spot,
        fundingRate: 0.005,
        perpPrice: 60_000,
        hedgePrice: null,
        fundingIntervalHours: 8,
        notionalUsd: 10_000,
      });
      expect(v.open).toBe(false);
      if (!v.open) expect(v.reason).toBe("hedge_price_unavailable");
    });
  });
});

describe("harvester — pair construction, funding credits, exits", () => {
  const perp = new ApexPerpVenue(okFetch({}));
  const perpAsSpot = new SyntheticSpotVenue(perp);

  const basePair: ArbiterPair = {
    pairId: "p1",
    kind: "funding_harvest",
    symbol: "BTC-USDT",
    openedAtMs: 0,
    receiver: {
      venueId: "apex_perp",
      symbol: "BTC-USDT",
      direction: "short",
      notional: 10_000,
      entryPrice: 60_000,
      entryFeesUsd: 5,
    },
    hedge: {
      venueId: "kraken_spot",
      symbol: "BTC-USDT",
      direction: "long",
      notional: 10_000,
      entryPrice: 60_000,
      entryFeesUsd: 26,
    },
    triggerRate: 0.005,
    projectedNetApr: 5.4,
  };

  it("buildPair debits fees per leg", () => {
    withEnabled(() => {
      const decision = evaluateHarvest({
        symbol: "BTC-USDT",
        perp,
        hedge: perpAsSpot,
        fundingRate: 0.005,
        perpPrice: 60_000,
        hedgePrice: 60_000,
        fundingIntervalHours: 8,
        notionalUsd: 10_000,
      });
      expect(decision.open).toBe(true);
      if (!decision.open) return;
      const pair = buildPair(decision.candidate, 60_000, 60_000, perp, perpAsSpot, 10_000, 1, "p-a");
      expect(pair.receiver.entryFeesUsd).toBeCloseTo((10_000 * perp.takerFeeBps) / 10_000, 6);
      expect(pair.hedge.entryFeesUsd).toBeCloseTo((10_000 * perpAsSpot.takerFeeBps) / 10_000, 6);
      expect(pair.receiver.direction).toBe("short");
      expect(pair.hedge.direction).toBe("long");
    });
  });

  it("accrueFundingCredit: short receiver + positive rate → CREDIT (positive)", () => {
    const credit = accrueFundingCredit(basePair, 0.005);
    // short: dirSign=-1; -rate * notional * -1 = rate * notional > 0
    expect(credit).toBeCloseTo(0.005 * 10_000, 6);
    expect(credit).toBeGreaterThan(0);
  });

  it("basisDivergence and legImbalanceFrac math", () => {
    expect(basisDivergence(60_000, 60_600)).toBeCloseTo(0.01, 6);
    expect(legImbalanceFrac({ ...basePair, hedge: { ...basePair.hedge, notional: 10_200 } }))
      .toBeCloseTo(200 / 10_200, 6);
  });

  it("exit — funding flip closes pair", () => {
    const v = evaluateHarvestExit({
      pair: basePair,
      currentRate: -0.001,
      currentPerpPrice: 60_000,
      currentHedgePrice: 60_000,
      currentNetApr: 5,
    });
    expect(v.exit).toBe(true);
    if (v.exit) expect(v.reason).toBe("arbiter_funding_flip");
  });

  it("exit — basis stop overrides funding flip (safety valve priority)", () => {
    const v = evaluateHarvestExit({
      pair: basePair,
      currentRate: 0.005,
      currentPerpPrice: 60_000,
      currentHedgePrice: 65_000, // 8.3% basis
      currentNetApr: 5,
    });
    expect(v.exit).toBe(true);
    if (v.exit) expect(v.reason).toBe("arbiter_basis_stop");
  });

  it("exit — net APR decay below exit_apr closes as harvest_complete", () => {
    const v = evaluateHarvestExit({
      pair: basePair,
      currentRate: 0.005,
      currentPerpPrice: 60_000,
      currentHedgePrice: 60_000,
      currentNetApr: 0.01, // below exit_apr 0.03
    });
    expect(v.exit).toBe(true);
    if (v.exit) expect(v.reason).toBe("arbiter_harvest_complete");
  });
});
