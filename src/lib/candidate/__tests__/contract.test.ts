// Candidate-contract parity and lifecycle-derivation proofs.
//
// The fixture in tests/fixtures/candidate/contract_v1.json is produced by the
// Python side (`candidate_contract.py`). Both languages assert against the
// same expected bytes, so drift fails a test instead of silently producing two
// different candidate identities for one real-world confirmation.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildCandidate,
  canonicalJson,
  candidateId,
  evidenceHash,
} from "@/lib/candidate/contract";
import {
  deriveLifecycleStates,
  parseCandidateRow,
  candidateFreshness,
} from "@/lib/candidate/lifecycle";

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "tests/fixtures/candidate/contract_v1.json"), "utf8"),
) as {
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  expected_canonical_evidence: string;
};

const input = fixture.input as {
  strategy: string;
  connection_id: string;
  symbol: string;
  timeframe: string;
  direction: "long" | "short";
  candle_close_ms: number;
  confirmation_ref: string;
  market_data_ts_ms: number;
  evidence: Record<string, unknown>;
  entry_zone: { low: number; high: number };
  invalidation: number;
  tp_ladder: { rr_multiple: number; size_frac: number }[];
};

function build() {
  return buildCandidate({
    strategy: input.strategy,
    connectionId: input.connection_id,
    symbol: input.symbol,
    timeframe: input.timeframe,
    direction: input.direction,
    candleCloseMs: input.candle_close_ms,
    confirmationRef: input.confirmation_ref,
    marketDataTsMs: input.market_data_ts_ms,
    evidence: input.evidence,
    entryZone: input.entry_zone,
    invalidation: input.invalidation,
    tpLadder: input.tp_ladder,
  });
}

describe("candidate contract — cross-language parity", () => {
  it("serializes evidence identically to the Python mirror", () => {
    expect(canonicalJson(input.evidence)).toBe(fixture.expected_canonical_evidence);
  });

  it("reproduces the Python evidence hash", async () => {
    await expect(evidenceHash(input.evidence)).resolves.toBe(fixture.expected.evidence_hash);
  });

  it("reproduces the whole Python contract", async () => {
    await expect(build()).resolves.toEqual(fixture.expected);
  });
});

describe("candidate identity", () => {
  const parts = {
    strategy: input.strategy,
    connectionId: input.connection_id,
    symbol: input.symbol,
    direction: input.direction,
    candleCloseMs: input.candle_close_ms,
    confirmationRef: input.confirmation_ref,
  };

  it("is deterministic across repeated computation", async () => {
    const a = await candidateId(parts);
    const b = await candidateId(parts);
    expect(a).toBe(b);
    expect(a).toBe(fixture.expected.candidate_id);
  });

  it("normalizes symbol case and strategy case", async () => {
    const normalized = await candidateId({
      ...parts,
      symbol: parts.symbol.toLowerCase(),
      strategy: parts.strategy.toUpperCase(),
    });
    expect(normalized).toBe(fixture.expected.candidate_id);
  });

  it("changes when the confirmed candle changes", async () => {
    const other = await candidateId({ ...parts, candleCloseMs: parts.candleCloseMs + 300_000 });
    expect(other).not.toBe(fixture.expected.candidate_id);
  });

  it("changes when the direction changes", async () => {
    const other = await candidateId({ ...parts, direction: "short" });
    expect(other).not.toBe(fixture.expected.candidate_id);
  });

  it("carries no credential or personal data in the id", async () => {
    const id = await candidateId(parts);
    expect(id.startsWith("cand_v1_")).toBe(true);
    expect(id).not.toContain(parts.connectionId);
    expect(/^cand_v1_[0-9a-f]{32}$/.test(id)).toBe(true);
  });

  it("keeps the evidence hash stable under key reordering", async () => {
    const reordered = Object.fromEntries(
      Object.entries(input.evidence).reverse(),
    ) as Record<string, unknown>;
    await expect(evidenceHash(reordered)).resolves.toBe(fixture.expected.evidence_hash);
  });

  it("changes the evidence hash when any value changes", async () => {
    const mutated = { ...input.evidence, regime: "chop" };
    await expect(evidenceHash(mutated)).resolves.not.toBe(fixture.expected.evidence_hash);
  });
});

const baseRow = {
  candidate_id: "cand_v1_" + "a".repeat(32),
  connection_id: "11111111-2222-3333-4444-555555555555",
  strategy: "accumulator",
  symbol: "BTC-USDT",
  timeframe: "5m",
  direction: "long",
  candle_close_at: "2025-07-31T00:00:00.000Z",
  market_data_at: "2025-07-31T00:00:12.000Z",
  freshness_ms: 12_000,
  entry_zone: { low: 1, high: 2 },
  invalidation: 0.9,
  tp_ladder: [],
  evidence: { regime: "trend" },
  evidence_hash: "f".repeat(64),
  schema_version: "candidate.v1",
  technical_decision: "technical_validated",
  technical_reason: null,
  idempotency_key: "accum:conn:BTC-USDT:long:1:2",
  ai_shadow_state: "ai_shadow_pending",
  created_at: "2025-07-31T00:00:13.000Z",
};

describe("candidate row parsing", () => {
  it("parses a well-formed row", () => {
    const parsed = parseCandidateRow(baseRow);
    expect(parsed?.candidateId).toBe(baseRow.candidate_id);
    expect(parsed?.direction).toBe("long");
  });

  it("fails closed on a malformed row instead of coercing", () => {
    expect(parseCandidateRow({ ...baseRow, direction: "sideways" })).toBeNull();
    expect(parseCandidateRow({ ...baseRow, candidate_id: 42 })).toBeNull();
    expect(parseCandidateRow(null)).toBeNull();
  });
});

describe("lifecycle derivation", () => {
  const candidate = parseCandidateRow(baseRow)!;

  it("reports AI pending when nothing has been evaluated", () => {
    expect(deriveLifecycleStates(candidate, null, null)).toEqual([
      "candidate_created",
      "technical_validated",
      "ai_shadow_pending",
    ]);
  });

  it("never fabricates order stages without an intent", () => {
    const states = deriveLifecycleStates(candidate, null, null);
    expect(states).not.toContain("order_submitted");
    expect(states).not.toContain("filled");
    expect(states).not.toContain("execution_approved");
  });

  it("maps a filled intent through the whole execution chain", () => {
    expect(deriveLifecycleStates(candidate, null, "filled")).toEqual([
      "candidate_created",
      "technical_validated",
      "ai_shadow_pending",
      "execution_approved",
      "order_submitted",
      "filled",
    ]);
  });

  it("records rejection without inventing a submission", () => {
    const states = deriveLifecycleStates(candidate, null, "rejected");
    expect(states).toContain("execution_rejected");
    expect(states).not.toContain("order_submitted");
  });

  it("ignores an unknown/out-of-order intent state rather than guessing", () => {
    expect(deriveLifecycleStates(candidate, null, "teleported")).toEqual([
      "candidate_created",
      "technical_validated",
      "ai_shadow_pending",
    ]);
  });

  it("marks AI unavailable when every provider seat failed", () => {
    const evaluation = {
      id: null,
      candidateId: candidate.candidateId,
      strategy: "accumulator",
      symbol: "BTC-USDT",
      timeframe: "5m",
      candleCloseAt: baseRow.candle_close_at,
      schemaVersion: "committee.v1",
      evidenceHash: baseRow.evidence_hash,
      verdict: "shadow_unavailable" as const,
      consensusDirection: null,
      consensusConfidence: null,
      riskFlags: [],
      availableRoles: [],
      unavailableRoles: ["lead" as const, "risk" as const, "structure" as const],
      riskDissent: false,
      outcomes: [],
      totalLatencyMs: 10,
      promptVersion: null,
      scorerVersion: null,
      shadowScore: null,
      scoreBand: null,
      advisory: true as const,
    };
    expect(deriveLifecycleStates(candidate, evaluation, null)).toContain("ai_shadow_unavailable");
  });

  it("distinguishes a current candidate from a historical one", () => {
    const closed = Date.parse(baseRow.candle_close_at);
    expect(candidateFreshness(candidate, closed + 60_000, 900_000)).toBe("current");
    expect(candidateFreshness(candidate, closed + 3_600_000, 900_000)).toBe("stale");
  });
});
