/**
 * Dynamic market universe — public types.
 *
 * The universe pipeline has three deterministic stages that each produce a
 * typed, persistable artifact:
 *
 *   1. Adapter          → VerifiedUniverse       (real exchange metadata)
 *   2. Eligibility      → EligibleSymbol[]       (fail-closed filter)
 *   3. Ranking          → RankedSymbol[]         (deterministic scorer)
 *
 * A `UniverseSnapshot` bundles all three plus the version identifiers used to
 * produce it, plus health and correlation id so the persisted row is
 * self-describing for the UI and audit trail.
 */

/** JSON-serializable value — matches the TanStack Start serializer contract. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

export type UniverseHealth = "healthy" | "degraded" | "offline" | "unverified";
export type RankingBucket = "watching" | "eligible" | "ranked" | "rejected";
export type OverrideKind = "allow" | "deny" | "emergency_allow";
export type UniverseMarketType = "paper" | "futures" | "spot";
export type UniverseEnvironment = "paper" | "testnet" | "mainnet";
export type RankingDirection = "long" | "short" | "hedge" | "wait" | "none";

/** Per-instrument metadata returned by a real venue adapter. */
export interface VerifiedInstrument {
  /** Canonical Scout symbol (e.g. "BTC-USDT"). */
  symbol: string;
  /** Venue-native symbol (e.g. "BTCUSDT"). */
  venueSymbol: string;
  base: string;
  quote: string;
  /** True if the exchange currently reports the instrument as tradable. */
  tradable: boolean;
  /** Verified exchange maximum leverage for this instrument. */
  maxLeverage: number | null;
  /** Minimum price tick. */
  tickSize: number | null;
  /** Minimum trade quantity. */
  minQty: number | null;
  /** Minimum notional in quote currency. */
  minNotional: number | null;
  /** 24h volume in quote currency, when available. */
  volume24hUsd: number | null;
  /** Best-bid / best-ask spread in basis points, when available. */
  spreadBps: number | null;
  /** Age of the metadata read, in ms. */
  ageMs: number;
}

export interface VerifiedUniverse {
  exchange: string;
  environment: UniverseEnvironment;
  marketType: UniverseMarketType;
  adapterVersion: number;
  capabilityVersion: number;
  health: UniverseHealth;
  instruments: VerifiedInstrument[];
  /** Free-form adapter metadata (endpoint, upstream health, error, etc.). */
  detail: Record<string, JsonValue>;
  /** Wall-clock time the adapter finished producing this universe. */
  generatedAt: number;
}

export interface EligibilityConfig {
  version: number;
  /** Maximum acceptable metadata age. */
  maxAgeMs: number;
  /** Minimum 24h quote-currency volume required to be tradable. */
  minVolumeUsd: number;
  /** Maximum acceptable spread in basis points. */
  maxSpreadBps: number;
  /** Minimum verified exchange max leverage. */
  minExchangeMaxLeverage: number;
  /** Every instrument must have these numeric fields to pass. */
  requireFields: Array<keyof VerifiedInstrument>;
}

export interface EligibleSymbol {
  instrument: VerifiedInstrument;
  eligible: boolean;
  reasons: string[];
}

export interface ScoreComponents {
  regime: number;
  alignment: number;
  readiness: number;
  confidence: number;
  liquidity: number;
  freshness: number;
  volatility: number;
}

export interface RankedSymbol {
  symbol: string;
  bucket: RankingBucket;
  /** Deterministic rank across the eligible set. Null when bucket != 'ranked'. */
  rank: number | null;
  rawScore: number;
  adjustedScore: number;
  direction: RankingDirection;
  components: ScoreComponents;
  rejectionReasons: string[];
  instrument: VerifiedInstrument;
  signalFresh: boolean;
}

export interface UniverseSnapshot {
  correlationId: string;
  userId: string;
  connectionId: string | null;
  exchange: string;
  environment: UniverseEnvironment;
  marketType: UniverseMarketType;
  adapterVersion: number;
  capabilityVersion: number;
  universeVersion: number;
  rankingVersion: number;
  health: UniverseHealth;
  exchangeSymbolCount: number;
  eligibleCount: number;
  rankedCount: number;
  rejectedCount: number;
  generatedAt: number;
  expiresAt: number;
  detail: Record<string, JsonValue>;
  rankings: RankedSymbol[];
}

export interface UniverseAdapter {
  readonly exchange: string;
  readonly adapterVersion: number;
  discover(ctx: {
    environment: UniverseEnvironment;
    marketType: UniverseMarketType;
    now?: number;
  }): Promise<VerifiedUniverse>;
}

export interface UniverseOverride {
  symbol: string;
  kind: OverrideKind;
  expiresAt: number | null;
  reason: string | null;
}

/** Precedence-resolved decision for a single symbol. */
export interface ResolvedOverride {
  symbol: string;
  effective: "force_include" | "force_exclude" | "none";
  source: OverrideKind | null;
}
