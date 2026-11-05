import { describe, it, expect } from "vitest";
import {
  buildEnvelope,
  guardEnvelope,
  ENVELOPE_VERSION,
  MAX_ENVELOPE_AGE_MS,
} from "../envelope";
import { EVIDENCE_SCHEMA_VERSION, RULES_VERSION } from "@/lib/scout/versions";

function fresh(overrides: Partial<Parameters<typeof buildEnvelope>[0]> = {}) {
  return buildEnvelope({
    scan_id: "scan-1",
    symbol: "BTC-USDT",
    regime: "trend",
    long_score: 0.7,
    short_score: 0.1,
    supporting_codes: ["trend_up"],
    conflicting_codes: [],
    data_ts: 1000,
    created_at: 1000,
    execution: {
      hedge_capable: true,
      required_context_fresh: true,
      kill_switch_active: false,
      mainnet_enabled: false,
    },
    ...overrides,
  });
}

describe("guardEnvelope", () => {
  it("passes for fresh, version-matched, safety-clean envelope", () => {
    expect(guardEnvelope(fresh(), 1000).ok).toBe(true);
  });

  it("rejects envelope_version mismatch", () => {
    const env = { ...fresh(), envelope_version: ENVELOPE_VERSION + 1 };
    expect(guardEnvelope(env, 1000)).toEqual({ ok: false, reason: "ENVELOPE_VERSION_MISMATCH" });
  });

  it("rejects evidence_schema_version mismatch", () => {
    const env = { ...fresh(), evidence_schema_version: EVIDENCE_SCHEMA_VERSION + 99 };
    expect(guardEnvelope(env, 1000).ok).toBe(false);
  });

  it("rejects rules_version mismatch", () => {
    const env = { ...fresh(), rules_version: RULES_VERSION + 99 };
    expect(guardEnvelope(env, 1000).ok).toBe(false);
  });

  it("fails closed when mainnet flag is set", () => {
    const env = fresh({ execution: { hedge_capable: true, required_context_fresh: true, kill_switch_active: false, mainnet_enabled: true } });
    expect(guardEnvelope(env, 1000)).toEqual({ ok: false, reason: "MAINNET_ACTIVE" });
  });

  it("fails closed on kill switch", () => {
    const env = fresh({ execution: { hedge_capable: true, required_context_fresh: true, kill_switch_active: true, mainnet_enabled: false } });
    expect(guardEnvelope(env, 1000)).toEqual({ ok: false, reason: "KILL_SWITCH_ACTIVE" });
  });

  it("rejects when required H4/D context stale", () => {
    const env = fresh({ execution: { hedge_capable: true, required_context_fresh: false, kill_switch_active: false, mainnet_enabled: false } });
    expect(guardEnvelope(env, 1000)).toEqual({ ok: false, reason: "REQUIRED_CONTEXT_STALE" });
  });

  it("rejects envelope older than MAX_ENVELOPE_AGE_MS", () => {
    const env = fresh({ created_at: 0 });
    expect(guardEnvelope(env, MAX_ENVELOPE_AGE_MS + 1)).toEqual({ ok: false, reason: "ENVELOPE_STALE" });
  });

  it("rejects envelope with negative age (clock skew)", () => {
    const env = fresh({ created_at: 5000 });
    expect(guardEnvelope(env, 1000)).toEqual({ ok: false, reason: "ENVELOPE_STALE" });
  });
});
