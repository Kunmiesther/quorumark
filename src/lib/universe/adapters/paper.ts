/**
 * Paper universe adapter.
 *
 * The "paper" exchange is treated as a verified venue: instrument metadata
 * is derived from the owner's `paper_test_symbols` seed plus the paper
 * defaults (leverage caps live in the paper engine constants). This lets
 * the dynamic universe pipeline run end-to-end for paper trading without
 * touching any real exchange.
 *
 * NB: the injector supplies the seed rows; this file stays pure so it can
 * be unit tested without a Supabase connection.
 */
import type { UniverseAdapter, VerifiedInstrument, VerifiedUniverse } from "../types";

export interface PaperSeedRow {
  symbol: string;
  enabled: boolean;
  max_leverage: number | null;
  market_available: boolean | null;
}

/** Builds a verified paper universe from seed rows. Pure — no I/O. */
export function buildPaperUniverse(
  seeds: PaperSeedRow[],
  now: number,
  environment: "paper" | "testnet" | "mainnet" = "paper",
): VerifiedUniverse {
  const instruments: VerifiedInstrument[] = seeds
    .filter((s) => s.enabled && (s.market_available ?? true))
    .map((s) => {
      const [base, quote] = s.symbol.split("-");
      const inst: VerifiedInstrument = {
        symbol: s.symbol,
        venueSymbol: s.symbol.replace("-", ""),
        base: base ?? s.symbol,
        quote: quote ?? "USDT",
        tradable: true,
        maxLeverage: s.max_leverage ?? 50,
        tickSize: 0.0001,
        minQty: 0.001,
        minNotional: 5,
        // Paper wallets don't have a real orderbook, so we synthesise
        // conservative liquidity/spread numbers that always PASS default
        // eligibility. These are labelled as synthetic in `detail`.
        volume24hUsd: 100_000_000,
        spreadBps: 5,
        ageMs: 0,
      };
      return inst;
    });

  return {
    exchange: "paper",
    environment,
    marketType: "paper",
    adapterVersion: 1,
    capabilityVersion: 1,
    health: instruments.length > 0 ? "healthy" : "offline",
    instruments,
    detail: {
      source: "paper_test_symbols",
      note: "synthetic liquidity/spread; leverage from seed row",
    },
    generatedAt: now,
  };
}

/**
 * Runtime adapter shim — expects seeds injected at call time. Callers that
 * need real rows should read `paper_test_symbols` first and pass them via
 * `discoverWithSeeds`.
 */
export const paperAdapter: UniverseAdapter = {
  exchange: "paper",
  adapterVersion: 1,
  async discover({ environment, marketType, now }) {
    // No seeds available at this call site — return an empty verified
    // universe rather than fabricating instruments. The higher-level
    // discover.functions caller passes seeds via `discoverWithSeeds`.
    return {
      exchange: "paper",
      environment,
      marketType,
      adapterVersion: 1,
      capabilityVersion: 1,
      health: "unverified",
      instruments: [],
      detail: { reason: "no_seeds_provided" },
      generatedAt: now ?? Date.now(),
    };
  },
};
