/**
 * Candidate selection contract — pure, no I/O.
 *
 * Proves the properties the desk relies on: TP geometry is projected only from
 * persisted facts, agreement is never inflated by unavailable seats, and Onyx
 * synthesis reports exactly what was recorded.
 */
import { describe, expect, it } from "vitest";
import {
  agreementCount,
  candidateEntry,
  candidateTpPrices,
  deriveLifecycleStates,
  type CandidateLifecycleDto,
  type CandidateRecord,
} from "@/lib/candidate/lifecycle";
import type { CommitteeEvaluationDto } from "@/lib/ai/committee/dto";
import { onyxSynthesis } from "@/lib/onyx/candidateSynthesis";

function candidate(over: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    candidateId: "cand_v1_aaa",
    connectionId: null,
    strategy: "accumulator",
    symbol: "BTC-USDT",
    timeframe: "5m",
    direction: "long",
    candleCloseAt: new Date().toISOString(),
    marketDataAt: null,
    freshnessMs: null,
    entryZone: { low: 100, high: 110 },
    invalidation: 95,
    tpLadder: [{ rr_multiple: 1, size_frac: 0.5 }, { rr_multiple: 2, size_frac: 0.5 }],
    evidence: {},
    evidenceHash: "hash-1",
    schemaVersion: "candidate.v1",
    technicalDecision: "technical_validated",
    technicalReason: null,
    idempotencyKey: null,
    aiShadowState: "ai_shadow_pending",
    createdAt: null,
    ...over,
  };
}

function evaluation(over: Partial<CommitteeEvaluationDto> = {}): CommitteeEvaluationDto {
  return {
    id: "eval-1",
    candidateId: "cand_v1_aaa",
    strategy: "accumulator",
    symbol: "BTC-USDT",
    timeframe: "5m",
    candleCloseAt: new Date().toISOString(),
    schemaVersion: "committee.v1",
    evidenceHash: "hash-1",
    verdict: "shadow_endorse",
    consensusDirection: "long",
    consensusConfidence: 0.7,
    riskFlags: [],
    availableRoles: ["lead", "risk"],
    unavailableRoles: ["structure"],
    riskDissent: false,
    outcomes: [
      {
        role: "lead",
        provider: "openai",
        model: "openai/gpt-5.6-sol",
        latencyMs: 10,
        available: true,
        response: {
          schema_version: "committee.v1",
          direction: "long",
          confidence: 0.8,
          entry_zone: null,
          invalidation: null,
          tp_levels: [],
          evidence: {
            trend: 0.5,
            pivots: 0.5,
            volume: 0.5,
            liquidity: 0.5,
            fvg: 0.5,
            historical_similarity: 0.5,
          },
          risk_flags: [],
          summary: "ok",
        },
      },
      {
        role: "structure",
        provider: "google",
        model: "google/gemini-3.1-pro-preview",
        latencyMs: 5,
        available: false,
        reason: "timeout",
        detail: "no answer",
      },
    ],
    totalLatencyMs: 20,
    promptVersion: "prompt.v1",
    scorerVersion: "scorer.v1",
    shadowScore: 71,
    scoreBand: null,
    advisory: true,
    ...over,
  };
}

describe("candidate selection contract", () => {
  it("projects TP prices from entry, invalidation and rr multiples", () => {
    expect(candidateEntry(candidate())).toBe(105);
    expect(candidateTpPrices(candidate())).toEqual([115, 125]);
  });

  it("mirrors geometry for shorts", () => {
    const c = candidate({ direction: "short", invalidation: 115 });
    expect(candidateTpPrices(c)).toEqual([95, 85]);
  });

  it("never invents levels when invalidation or zone is missing", () => {
    expect(candidateTpPrices(candidate({ invalidation: null }))).toEqual([]);
    expect(candidateTpPrices(candidate({ entryZone: null }))).toEqual([]);
  });

  it("counts agreement only across available seats", () => {
    expect(agreementCount(evaluation())).toEqual({ agree: 1, available: 1 });
    expect(agreementCount(null)).toEqual({ agree: 0, available: 0 });
  });

  it("derives no order stage when no intent is correlated", () => {
    const states = deriveLifecycleStates(candidate(), evaluation(), null);
    expect(states).toEqual(["candidate_created", "technical_validated", "ai_shadow_evaluated"]);
  });

  it("synthesis reports the persisted verdict and the absent order", () => {
    const dto: CandidateLifecycleDto = {
      candidate: candidate(),
      evaluation: evaluation(),
      orderState: null,
      states: [],
    };
    const text = onyxSynthesis(dto);
    expect(text).toContain("endorsed");
    expect(text).toContain("1 of 1");
    expect(text).toContain("No live order is associated");
  });

  it("synthesis reports pending rather than fabricating a verdict", () => {
    const dto: CandidateLifecycleDto = {
      candidate: candidate(),
      evaluation: null,
      orderState: null,
      states: [],
    };
    expect(onyxSynthesis(dto)).toContain("has not answered");
  });
});
