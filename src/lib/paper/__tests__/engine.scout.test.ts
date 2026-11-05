/**
 * engine.scout — documentation tests for Phase A.5 Scout ingestion.
 *
 * PURPOSE: The Phase A.5 block in `src/lib/paper/engine.ts` is INERT while
 * `DYNAMIC_UNIVERSE_ENABLED` is false (see `src/lib/paper/constants.ts`).
 * These tests document the observable contract when the flag flips true,
 * so re-enabling is a one-turn operation rather than a re-derivation.
 *
 * The three cases below mirror the branches around the universe-gate check
 * in engine.ts (search "PHASE A.5 — SCOUT SIGNAL INGESTION"). We test the
 * pure primitives (`selectFreshScoutSides` + an inline synthesis of the
 * gate decision) rather than spinning the full engine to keep the harness
 * lean and dependency-free.
 */
import { describe, it, expect } from "vitest";
import { selectFreshScoutSides, type RawScoutSignalRow } from "@/lib/paper/scoutIngestion";
import { EVIDENCE_SCHEMA_VERSION } from "@/lib/scout/versions";

const NOW = Date.UTC(2026, 6, 22, 12, 0, 0);

function mkSignal(overrides: Partial<RawScoutSignalRow> = {}): RawScoutSignalRow {
  return {
    id: "sig-1",
    symbol: "BTC-USDT",
    scan_id: "scan-1",
    created_at: new Date(NOW - 30_000).toISOString(),
    expires_at: new Date(NOW + 60_000).toISOString(),
    invalidated_at: null,
    regime_schema_version: EVIDENCE_SCHEMA_VERSION,
    market_regime: "strong_uptrend",
    long_state: "confirmed",
    long_fresh: true,
    short_state: "none",
    short_fresh: false,
    ...overrides,
  };
}

/** Minimal mirror of the engine gate decision for a synthesized scout candidate. */
type GateDecision =
  | { kind: "candidate"; leg: "scout"; symbol: string; direction: "long" | "short"; signalId: string }
  | { kind: "blocked_universe_capacity"; symbol: string; direction: "long" | "short" }
  | { kind: "already_traded"; symbol: string; direction: "long" | "short"; signalId: string };

function decideScoutCandidate(
  side: { symbol: string; direction: "long" | "short"; signalId: string },
  gate: { active: boolean; allowedNewEntries: Set<string> },
  tradedKeys: Set<string>,
): GateDecision {
  const tradedKey = `${side.symbol}:${side.direction}:scout:${side.signalId}`;
  if (tradedKeys.has(tradedKey)) {
    return { kind: "already_traded", symbol: side.symbol, direction: side.direction, signalId: side.signalId };
  }
  if (!gate.active || !gate.allowedNewEntries.has(side.symbol)) {
    return { kind: "blocked_universe_capacity", symbol: side.symbol, direction: side.direction };
  }
  return { kind: "candidate", leg: "scout", symbol: side.symbol, direction: side.direction, signalId: side.signalId };
}

const OPTS = { nowMs: NOW, evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION };

describe("Phase A.5 Scout ingestion — re-enable contract (DYNAMIC_UNIVERSE_ENABLED=true)", () => {
  it("(a) fresh confirmed scout + free wallet + gate allows → candidate leg='scout' reaches Onyx", () => {
    const [side] = selectFreshScoutSides([mkSignal()], OPTS);
    expect(side).toBeDefined();
    const d = decideScoutCandidate(
      side!,
      { active: true, allowedNewEntries: new Set(["BTC-USDT"]) },
      new Set(),
    );
    expect(d.kind).toBe("candidate");
    if (d.kind === "candidate") {
      expect(d.leg).toBe("scout");
      expect(d.symbol).toBe("BTC-USDT");
      expect(d.direction).toBe("long");
    }
  });

  it("(b) gate denies symbol → blocked_universe_capacity, no candidate", () => {
    const [side] = selectFreshScoutSides([mkSignal()], OPTS);
    const d = decideScoutCandidate(
      side!,
      { active: true, allowedNewEntries: new Set(["ETH-USDT"]) }, // BTC not allowed
      new Set(),
    );
    expect(d.kind).toBe("blocked_universe_capacity");
  });

  it("(c) signal id already in tradedKeys → skipped with already_traded", () => {
    const [side] = selectFreshScoutSides([mkSignal()], OPTS);
    const traded = new Set([`${side!.symbol}:${side!.direction}:scout:${side!.signalId}`]);
    const d = decideScoutCandidate(
      side!,
      { active: true, allowedNewEntries: new Set(["BTC-USDT"]) },
      traded,
    );
    expect(d.kind).toBe("already_traded");
  });

  it("gate inactive (flag off, current state) → every scout side blocks with blocked_universe_capacity", () => {
    const [side] = selectFreshScoutSides([mkSignal()], OPTS);
    const d = decideScoutCandidate(
      side!,
      { active: false, allowedNewEntries: new Set() },
      new Set(),
    );
    expect(d.kind).toBe("blocked_universe_capacity");
  });
});
