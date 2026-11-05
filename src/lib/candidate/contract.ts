// Canonical TurtleBot strategy-candidate contract (TypeScript mirror).
//
// PURE + SHADOW-SAFE. No I/O, no credential, no signer/broker reachability.
// The Python mirror is `candidate_contract.py`; parity is proven by
// `tests/fixtures/candidate/contract_v1.json` in both test suites.

export const CANDIDATE_SCHEMA_VERSION = "candidate.v1";

export const CANDIDATE_DIRECTIONS = ["long", "short"] as const;
export type CandidateDirection = (typeof CANDIDATE_DIRECTIONS)[number];

export interface CandidateEntryZone {
  low: number;
  high: number;
}

export interface CandidateTpRung {
  rr_multiple: number;
  size_frac: number;
}

export interface CandidateContract {
  schema_version: string;
  candidate_id: string;
  connection_id: string;
  strategy: string;
  symbol: string;
  timeframe: string;
  direction: CandidateDirection;
  candle_close_ms: number;
  confirmation_ref: string;
  market_data_ts_ms: number;
  freshness_ms: number;
  entry_zone: CandidateEntryZone | null;
  invalidation: number | null;
  tp_ladder: CandidateTpRung[];
  evidence: Record<string, unknown>;
  evidence_hash: string;
}

/**
 * Language-neutral decimal form. `JSON.stringify` and Python's `json.dumps`
 * disagree on float rendering, so numbers go through a fixed 10-decimal form
 * and are trimmed. Python implements exactly this.
 */
function canonicalNumber(value: number): string {
  let text = value.toFixed(10);
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text === "" || text === "-0" ? "0" : text;
}

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number in candidate contract");
    return canonicalNumber(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const src = value as Record<string, unknown>;
    const parts = Object.keys(src)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(src[k])}`);
    return `{${parts.join(",")}}`;
  }
  throw new TypeError("uncanonicalisable value in candidate contract");
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function evidenceHash(evidence: unknown): Promise<string> {
  return sha256Hex(canonicalJson(evidence));
}

export interface CandidateIdParts {
  strategy: string;
  connectionId: string;
  symbol: string;
  direction: CandidateDirection;
  candleCloseMs: number;
  confirmationRef: string;
}

/** Deterministic, idempotent identity — see the Python docstring for the invariant. */
export async function candidateId(parts: CandidateIdParts): Promise<string> {
  const seed = [
    CANDIDATE_SCHEMA_VERSION,
    parts.strategy.trim().toLowerCase(),
    parts.connectionId.trim(),
    parts.symbol.trim().toUpperCase(),
    parts.direction,
    String(Math.trunc(parts.candleCloseMs)),
    parts.confirmationRef.trim(),
  ].join("|");
  return `cand_v1_${(await sha256Hex(seed)).slice(0, 32)}`;
}

export interface BuildCandidateInput extends CandidateIdParts {
  timeframe: string;
  marketDataTsMs: number;
  evidence: Record<string, unknown>;
  entryZone?: CandidateEntryZone | null;
  invalidation?: number | null;
  tpLadder?: CandidateTpRung[] | null;
}

/**
 * Assemble the versioned wire contract shared with `candidate_contract.py`.
 *
 * `freshness_ms` is recorded, never used as an execution gate here: staleness
 * policy belongs to the deterministic worker, not to this contract.
 */
export async function buildCandidate(input: BuildCandidateInput): Promise<CandidateContract> {
  return {
    schema_version: CANDIDATE_SCHEMA_VERSION,
    candidate_id: await candidateId(input),
    connection_id: String(input.connectionId),
    strategy: input.strategy.trim().toLowerCase(),
    symbol: input.symbol.trim().toUpperCase(),
    timeframe: String(input.timeframe),
    direction: input.direction,
    candle_close_ms: Math.trunc(input.candleCloseMs),
    confirmation_ref: String(input.confirmationRef),
    market_data_ts_ms: Math.trunc(input.marketDataTsMs),
    freshness_ms: Math.trunc(input.marketDataTsMs) - Math.trunc(input.candleCloseMs),
    entry_zone: input.entryZone ?? null,
    invalidation: input.invalidation ?? null,
    tp_ladder: input.tpLadder ?? [],
    evidence: input.evidence,
    evidence_hash: await evidenceHash(input.evidence),
  };
}
