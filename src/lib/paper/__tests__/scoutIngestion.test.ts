import { describe, it, expect } from "vitest";
import {
  selectFreshScoutSides,
  type RawScoutSignalRow,
} from "@/lib/paper/scoutIngestion";
import { EVIDENCE_SCHEMA_VERSION } from "@/lib/scout/versions";

const NOW = Date.UTC(2026, 6, 22, 12, 0, 0);

function mk(overrides: Partial<RawScoutSignalRow> = {}): RawScoutSignalRow {
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

const OPTS = { nowMs: NOW, evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION };

describe("selectFreshScoutSides", () => {
  it("keeps a fresh confirmed long", () => {
    const out = selectFreshScoutSides([mk()], OPTS);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ symbol: "BTC-USDT", direction: "long", signalId: "sig-1" });
  });

  it("drops stale (expires_at <= now)", () => {
    const stale = mk({ expires_at: new Date(NOW - 1).toISOString() });
    expect(selectFreshScoutSides([stale], OPTS)).toHaveLength(0);
  });

  it("drops invalidated rows", () => {
    const inv = mk({ invalidated_at: new Date(NOW - 1_000).toISOString() });
    expect(selectFreshScoutSides([inv], OPTS)).toHaveLength(0);
  });

  it("drops schema-version mismatch", () => {
    const wrong = mk({ regime_schema_version: 999 });
    expect(selectFreshScoutSides([wrong], OPTS)).toHaveLength(0);
  });

  it("allows null schema-version (legacy row passes through)", () => {
    const legacy = mk({ regime_schema_version: null });
    expect(selectFreshScoutSides([legacy], OPTS)).toHaveLength(1);
  });

  it("dedupes signals already delivered", () => {
    const already = new Set(["sig-1"]);
    const out = selectFreshScoutSides([mk()], { ...OPTS, alreadyDecidedSignalIds: already });
    expect(out).toHaveLength(0);
  });

  it("emits both long and short when both sides are confirmed and fresh", () => {
    const both = mk({
      long_state: "confirmed", long_fresh: true,
      short_state: "confirmed", short_fresh: true,
    });
    const out = selectFreshScoutSides([both], OPTS);
    const dirs = out.map((s) => s.direction).sort();
    expect(dirs).toEqual(["long", "short"]);
  });

  it("dedupes (symbol,side): newest row wins", () => {
    const older = mk({ id: "old", created_at: new Date(NOW - 60_000).toISOString() });
    const newer = mk({ id: "new", created_at: new Date(NOW - 5_000).toISOString() });
    const out = selectFreshScoutSides([older, newer], OPTS);
    expect(out).toHaveLength(1);
    expect(out[0].signalId).toBe("new");
  });

  it("skips a side that is not confirmed or not fresh", () => {
    const watching = mk({ long_state: "watching", long_fresh: true });
    const notFresh = mk({ id: "sig-2", long_state: "confirmed", long_fresh: false });
    expect(selectFreshScoutSides([watching], OPTS)).toHaveLength(0);
    expect(selectFreshScoutSides([notFresh], OPTS)).toHaveLength(0);
  });
});

/**
 * Mainnet isolation static check — the pure Scout ingestion module MUST NOT
 * pull in any signer / execution-broker / order-intent / mainnet-flag path.
 * A regression here would mean paper-only ingestion could reach live
 * trading rails.
 */
describe("scoutIngestion mainnet isolation", () => {
  it("has zero forbidden imports", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/lib/paper/scoutIngestion.ts", "utf8");
    const forbidden = [
      "signer",
      "execution-broker",
      "order_intents",
      "mainnet-flags",
      "apex_execution_credentials",
      "supabase/functions",
      "client.server",
    ];
    for (const needle of forbidden) {
      expect(src.includes(needle), `must not reference ${needle}`).toBe(false);
    }
  });
});
