import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateDecision, opinionFailureReason } from "../decisionEvaluate.server";

const mocks = vi.hoisted(() => ({ run: vi.fn(), ledger: vi.fn() }));
vi.mock("../providers.server", () => ({ runFirstRound: mocks.run, PROMPT_VERSION: "test" }));
vi.mock("../ledger.server", () => ({ ledgerClient: mocks.ledger }));
vi.mock("@/lib/ai/usage.server", () => ({
  createAiUsageCollector: () => ({ onAttempt: vi.fn(), flush: vi.fn() }),
}));

const decision = { decision_id: "d1", user_id: "u1", evidence_hash: "h1" };
const opinions = ["lead", "risk", "structure"].map((role) => ({
  decision_id: "d1",
  role,
  provider: "test",
  model: "test",
  status: "unavailable",
  direction: null,
  confidence: null,
  prompt_version: "test",
  evidence_hash: "h1",
  unavailable_reason: "missing_key",
  evaluated_at: "2026-09-26T00:00:00Z",
}));
function client(results: Array<{ data?: unknown; error?: unknown }>) {
  const chains: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
  const from = vi.fn(() => {
    const result = results.shift();
    if (!result) throw new Error("Unexpected query");
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ["select", "eq", "maybeSingle", "upsert"]) {
      chain[method] = vi.fn(() => chain);
    }
    chain.then = vi.fn((resolve) => Promise.resolve(result).then(resolve));
    chains.push(chain);
    return chain;
  });
  return { db: { from } as unknown as SupabaseClient, from, chains };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.run.mockResolvedValue(
    opinions.map((o) => ({
      role: o.role,
      provider: o.provider,
      model: o.model,
      available: false,
      reason: "missing_key",
      latencyMs: 1,
    })),
  );
});

describe("decision advisory persistence", () => {
  it("retains safe HTTP diagnostics without provider text", () => {
    expect(
      opinionFailureReason("http_error", "provider responded 402: private billing details"),
    ).toBe("http_error:HTTP_402");
    expect(opinionFailureReason("http_error", "provider responded 429: rate limit")).toBe(
      "http_error:HTTP_429",
    );
    expect(opinionFailureReason("http_error", "arbitrary private text")).toBe("http_error");
  });
  it("scopes the decision to its owner", async () => {
    const reader = client([{ data: null }]);
    expect(await evaluateDecision(reader.db, "u1", "d1")).toEqual([]);
    expect(reader.chains[0].eq).toHaveBeenCalledWith("user_id", "u1");
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("surfaces decision-read errors instead of reporting no decision", async () => {
    const reader = client([{ error: { message: "sensitive database detail" } }]);
    await expect(evaluateDecision(reader.db, "u1", "d1")).rejects.toThrow(
      "AI_DECISION_READ_FAILED",
    );
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("does not spend provider calls when the opinion table is unavailable", async () => {
    const reader = client([{ data: decision }, { error: { code: "42P01" } }]);
    await expect(evaluateDecision(reader.db, "u1", "d1")).rejects.toThrow("AI_OPINION_READ_FAILED");
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("reuses complete persisted reviews", async () => {
    const reader = client([{ data: decision }, { data: opinions }]);
    expect(await evaluateDecision(reader.db, "u1", "d1")).toHaveLength(3);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("reports write failure rather than success", async () => {
    const reader = client([{ data: decision }, { data: [] }]);
    mocks.ledger.mockResolvedValue(client([{ error: { code: "42501" } }]).db);
    await expect(evaluateDecision(reader.db, "u1", "d1")).rejects.toThrow(
      "AI_OPINION_WRITE_FAILED",
    );
  });
  it.each([
    [{ error: { code: "42501" } }, "AI_OPINION_VERIFY_FAILED"],
    [{ data: [] }, "AI_OPINION_PERSISTENCE_INCOMPLETE"],
  ])("verifies that opinions actually persisted", async (result, code) => {
    const reader = client([{ data: decision }, { data: [] }, result]);
    mocks.ledger.mockResolvedValue(client([{ data: null }]).db);
    await expect(evaluateDecision(reader.db, "u1", "d1")).rejects.toThrow(code);
  });
  it("returns persisted unavailable opinions without inventing agreement", async () => {
    const reader = client([{ data: decision }, { data: [] }, { data: opinions }]);
    const writer = client([{ data: null }]);
    mocks.ledger.mockResolvedValue(writer.db);
    const result = await evaluateDecision(reader.db, "u1", "d1");
    expect(result).toHaveLength(3);
    expect(result.every((row) => row.status === "unavailable" && row.direction === null)).toBe(
      true,
    );
    expect(writer.chains[0].upsert).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ user_id: "u1", advisory: true })]),
      { onConflict: "decision_id,role,evidence_hash", ignoreDuplicates: true },
    );
  });
});
