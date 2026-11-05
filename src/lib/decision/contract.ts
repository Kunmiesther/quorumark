// Canonical TurtleBot decision contract (TypeScript mirror).
//
// PURE + EXECUTION-SAFE. No I/O, no credential, no signer/broker
// reachability. The Python mirror is `decision_contract.py`; parity is proven
// by `tests/fixtures/decision/contract_v1.json` in both test suites.
//
// Identity is EXACTLY the database's uniqueness tuple:
//   decision_id = f(schema, connection_id, symbol, candle_close_ms)
// Neither `direction` (an output of the reduction) nor `strategy` (already
// determined by the candle) is part of the seed — see decision_contract.py
// for why either one would let a single candle mint two identities.

export const DECISION_SCHEMA_VERSION = "decision.v1";

export const DECISION_DIRECTIONS = ["long", "short", "wait"] as const;
export type DecisionDirection = (typeof DECISION_DIRECTIONS)[number];

export interface DecisionEntryZone {
  low: number;
  high: number;
}

export interface DecisionContract {
  schema_version: string;
  decision_id: string;
  connection_id: string;
  symbol: string;
  strategy: string;
  candle_close_at: string;
  candle_close_ms: number;
  direction: DecisionDirection;
  reason_code: string;
  reason: string;
  entry_zone: DecisionEntryZone | null;
  invalidation: number | null;
  take_profits: number[];
  evidence_hash: string;
  created_at: string;
}

/** Language-neutral decimal form. Python implements exactly this. */
function canonicalNumber(value: number): string {
  let text = value.toFixed(10);
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text === "" || text === "-0" ? "0" : text;
}

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number in decision contract");
    return canonicalNumber(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  throw new TypeError(`uncanonicalisable value of type ${typeof value}`);
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Full sha256 of the immutable deterministic evidence block. */
export function evidenceHash(evidence: unknown): Promise<string> {
  return sha256Hex(canonicalJson(evidence));
}

/** Deterministic, idempotent identity for one completed candle. */
export async function decisionId(input: {
  connectionId: string;
  symbol: string;
  candleCloseMs: number;
}): Promise<string> {
  const seed = [
    DECISION_SCHEMA_VERSION,
    input.connectionId.trim(),
    input.symbol.trim().toUpperCase(),
    String(Math.trunc(input.candleCloseMs)),
  ].join("|");
  return `dec_v1_${(await sha256Hex(seed)).slice(0, 32)}`;
}
