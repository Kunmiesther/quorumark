import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DECISION_SCHEMA_VERSION,
  canonicalJson,
  decisionId,
  evidenceHash,
} from "@/lib/decision/contract";

/**
 * Cross-language parity. The Python mirror generated this fixture; if the two
 * canonical serializers ever disagree, a decision recorded by the worker and
 * the same decision computed in the browser would carry different ids and the
 * UI would silently show a different candle.
 */
const fixture = JSON.parse(
  readFileSync("tests/fixtures/decision/contract_v1.json", "utf8"),
) as {
  input: {
    connection_id: string;
    symbol: string;
    candle_close_ms: number;
    evidence: Record<string, unknown>;
  };
  expected: { decision_id: string; evidence_hash: string; canonical_evidence: string };
};

describe("decision contract parity with Python", () => {
  it("serializes evidence byte-identically", () => {
    expect(canonicalJson(fixture.input.evidence)).toBe(fixture.expected.canonical_evidence);
  });

  it("computes the same evidence hash", async () => {
    expect(await evidenceHash(fixture.input.evidence)).toBe(fixture.expected.evidence_hash);
  });

  it("computes the same decision id", async () => {
    const id = await decisionId({
      connectionId: fixture.input.connection_id,
      symbol: fixture.input.symbol,
      candleCloseMs: fixture.input.candle_close_ms,
    });
    expect(id).toBe(fixture.expected.decision_id);
  });

  it("is stable across repeated calls", async () => {
    const args = {
      connectionId: fixture.input.connection_id,
      symbol: fixture.input.symbol,
      candleCloseMs: fixture.input.candle_close_ms,
    };
    const ids = await Promise.all(Array.from({ length: 20 }, () => decisionId(args)));
    expect(new Set(ids).size).toBe(1);
  });

  it("separates symbols so BTC and ETH can never collide", async () => {
    const base = { connectionId: "c", candleCloseMs: 1 };
    const eth = await decisionId({ ...base, symbol: "ETH-USDT" });
    const btc = await decisionId({ ...base, symbol: "BTC-USDT" });
    expect(eth).not.toBe(btc);
  });

  it("normalises symbol case and padding rather than forking identity", async () => {
    const a = await decisionId({ connectionId: "c", symbol: "eth-usdt", candleCloseMs: 1 });
    const b = await decisionId({ connectionId: "c", symbol: " ETH-USDT ", candleCloseMs: 1 });
    expect(a).toBe(b);
  });

  it("pins the schema version that the id is seeded with", () => {
    expect(DECISION_SCHEMA_VERSION).toBe("decision.v1");
  });
});
