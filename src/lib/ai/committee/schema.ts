// Versioned, provider-neutral response contract for the AI committee.
//
// SHADOW MODE. Nothing in this module — or anything that consumes it —
// may submit, resize, cancel, or close an order. The schema deliberately
// contains no order id, no quantity, no credential, and no venue handle.

import { z } from "zod";

/** Bump when the response contract changes. Persisted with every record. */
export const COMMITTEE_SCHEMA_VERSION = "committee.v1";

export const ROLES = ["lead", "risk", "structure"] as const;
export type CommitteeRole = (typeof ROLES)[number];

export const DIRECTIONS = ["long", "short", "no_trade"] as const;
export type CommitteeDirection = (typeof DIRECTIONS)[number];

const score01 = z.number().min(0).max(1);

export const evidenceScoresSchema = z.object({
  trend: score01,
  pivots: score01,
  volume: score01,
  liquidity: score01,
  fvg: score01,
  historical_similarity: score01,
});
export type EvidenceScores = z.infer<typeof evidenceScoresSchema>;

export const committeeResponseSchema = z.object({
  schema_version: z.literal(COMMITTEE_SCHEMA_VERSION),
  direction: z.enum(DIRECTIONS),
  confidence: score01,
  entry_zone: z.object({ low: z.number(), high: z.number() }).nullable(),
  invalidation: z.number().nullable(),
  tp_levels: z.array(z.number()),
  evidence: evidenceScoresSchema,
  risk_flags: z.array(z.string()),
  summary: z.string(),
});
export type CommitteeResponse = z.infer<typeof committeeResponseSchema>;

/** Why a provider produced no usable answer. Never guessed, always recorded. */
export const unavailableReasonSchema = z.enum([
  "missing_credential",
  "timeout",
  "http_error",
  "malformed_json",
  "schema_invalid",
  "empty_response",
  "stale_snapshot",
  // Seat configured with a model id the gateway cannot route (missing
  // `vendor/` prefix, blank, or otherwise malformed). Recorded rather than
  // sent, so a typo shows up as a config fault instead of an HTTP 400.
  "invalid_model_config",
]);

export type UnavailableReason = z.infer<typeof unavailableReasonSchema>;

const providerOutcomeBase = {
  role: z.enum(ROLES),
  provider: z.string(),
  model: z.string(),
  latencyMs: z.number(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
  }).optional(),
};

export const providerOutcomeOkSchema = z.object({
  ...providerOutcomeBase,
  available: z.literal(true),
  response: committeeResponseSchema,
});

export const providerOutcomeUnavailableSchema = z.object({
  ...providerOutcomeBase,
  available: z.literal(false),
  reason: unavailableReasonSchema,
  /** Short, sanitized. Never contains a key, header, or raw provider body. */
  detail: z.string(),
});

export const providerOutcomeSchema = z.discriminatedUnion("available", [
  providerOutcomeOkSchema,
  providerOutcomeUnavailableSchema,
]);

export type ProviderOutcomeOk = z.infer<typeof providerOutcomeOkSchema>;
export type ProviderOutcomeUnavailable = z.infer<typeof providerOutcomeUnavailableSchema>;
export type ProviderOutcome = z.infer<typeof providerOutcomeSchema>;


/**
 * Parse an untrusted provider payload. Fails closed: any deviation from the
 * contract yields an `UnavailableReason`, never a coerced or guessed value.
 */
/**
 * Pull the JSON object out of a reply that may be wrapped in prose or fences.
 * Claude in particular sometimes prefixes a sentence before the object. That
 * is a formatting difference, not a different answer, so discarding the whole
 * opinion over it lost real signal.
 */
function extractJsonObject(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (cleaned.startsWith("{")) return cleaned;
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
}

const DIRECTION_SYNONYMS: Record<string, CommitteeDirection> = {
  long: "long",
  buy: "long",
  bullish: "long",
  short: "short",
  sell: "short",
  bearish: "short",
  no_trade: "no_trade",
  "no trade": "no_trade",
  none: "no_trade",
  wait: "no_trade",
  hold: "no_trade",
  flat: "no_trade",
  neutral: "no_trade",
};

/**
 * Normalize presentation-level differences ONLY: JSON wrapping, direction
 * synonyms, and omitted empty collections. Numeric values are NEVER rescaled
 * or clamped — an out-of-contract confidence or evidence score still fails,
 * because silently reinterpreting a number would change the answer.
 */
function normalizePayload(input: unknown): unknown {
  if (input == null || typeof input !== "object" || Array.isArray(input)) return input;
  const o = { ...(input as Record<string, unknown>) };
  // Fill only when the model omitted it. A WRONG version is a contract
  // mismatch and must still fail.
  if (o.schema_version == null || o.schema_version === "") {
    o.schema_version = COMMITTEE_SCHEMA_VERSION;
  }
  if (typeof o.direction === "string") {
    const mapped = DIRECTION_SYNONYMS[o.direction.trim().toLowerCase()];
    if (mapped) o.direction = mapped;
  }
  if (o.risk_flags == null) o.risk_flags = [];
  if (o.tp_levels == null) o.tp_levels = [];
  if (o.entry_zone === undefined) o.entry_zone = null;
  if (o.invalidation === undefined) o.invalidation = null;
  return o;
}

export function parseCommitteeResponse(
  raw: string | null | undefined,
): { ok: true; value: CommitteeResponse } | { ok: false; reason: UnavailableReason; detail: string } {
  if (raw == null || raw.trim() === "") {
    return { ok: false, reason: "empty_response", detail: "provider returned no content" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch {
    return { ok: false, reason: "malformed_json", detail: "response was not valid JSON" };
  }

  const result = committeeResponseSchema.safeParse(normalizePayload(parsed));
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path?.join(".") || "(root)";
    return { ok: false, reason: "schema_invalid", detail: `${path}: ${first?.code ?? "invalid"}` };
  }
  return { ok: true, value: result.data };
}


/** The immutable market snapshot every provider sees. Identical per round. */
export interface MarketSnapshot {
  /** Public on-chain quote evidence. No wallet address, balance or signing authority. */
  spot_swap?: {
    token_contract?: string;
    chain_id: number; router: string; pool: string; observed_block: string;
    sell_asset: string; buy_asset: string; sell_amount: string; quoted_output: string;
    minimum_output: string; slippage_bps: number; pool_fee_bps: number;
    evidence_kind: "block_quote_without_candles";
  };
  /** Validated manual configuration, advisory context only; never order authority. */
  manual_ticket?: import("../manualCouncil.functions").ManualCouncilDraft;
  candidate_id: string;
  strategy: string;
  symbol: string;
  timeframe: string;
  /** Completed-candle close time, or observed block time for spot_swap (ms). */
  candle_close_ms: number;
  deterministic: {
    proposed_direction: CommitteeDirection;
    entry: number | null;
    entry_zone: { low: number; high: number } | null;
    invalidation: number | null;
    tp_levels: number[];
    regime: string | null;
    trend_state: string | null;
    trend_slope_pct: number | null;
    atr_pct: number | null;
    recent_closes: number[];
    recent_highs: number[];
    recent_lows: number[];
    volume_profile: number[];
  };
  /**
   * Higher-timeframe context accompanying the entry frame. Optional because
   * not every caller folds HTF data; when present, a null frame means the
   * frame was unavailable, not that it was ignored.
   */
  higher_timeframes?: {
    setup_15m_close_ms: number | null;
    regime_1h_close_ms: number | null;
    regime_4h_close_ms: number | null;
    regime_1d_close_ms?: number | null;
    bos_1h: string | null;
    bos_4h: string | null;
    bos_1d?: string | null;
    environment_daily_available: boolean;
    /**
     * Native venue 1d / 1w / 1M summaries. Advisory context only — these
     * never gate, size or alter a trade. Null means the frames could not be
     * fetched for this candidate.
     */
    environment_frames?: Record<string, unknown> | null;
    environment_unavailable_reason?: string | null;
  };
}

/** Stable, key-sorted serialization used for the evidence hash. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) out[k] = walk(src[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}
