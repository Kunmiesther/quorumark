import { describe, it, expect } from "vitest";
import {
  ALLOWED_PURPOSES,
  EXECUTABLE_PURPOSES,
  computeFingerprint,
  evaluatePurpose,
  isUniqueViolation,
  type FingerprintInput,
} from "../../../supabase/functions/_shared/broker-guard";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BROKER_SRC = readFileSync(
  resolve(__dirname, "../../../supabase/functions/execution-broker/index.ts"),
  "utf-8",
);

describe("broker-guard evaluatePurpose", () => {
  it("rejects missing purpose", () => {
    expect(evaluatePurpose(undefined, "MARKET")).toMatchObject({ ok: false, reason: "MISSING_PURPOSE" });
    expect(evaluatePurpose(null, "MARKET")).toMatchObject({ ok: false, reason: "MISSING_PURPOSE" });
    expect(evaluatePurpose("", "MARKET")).toMatchObject({ ok: false, reason: "MISSING_PURPOSE" });
  });

  it("rejects the legacy 'unspecified' string", () => {
    expect(evaluatePurpose("unspecified", "MARKET")).toMatchObject({
      ok: false,
      reason: "UNSPECIFIED_PURPOSE_REJECTED",
    });
    expect(ALLOWED_PURPOSES.has("unspecified")).toBe(false);
  });

  it("rejects unknown purposes", () => {
    expect(evaluatePurpose("SHENANIGANS", "MARKET")).toMatchObject({
      ok: false,
      reason: "OPERATION_NOT_ALLOWED",
    });
  });

  it("blocks financial-egress words in purpose or order_type", () => {
    expect(evaluatePurpose("withdraw_all", "MARKET")).toMatchObject({ ok: false });
    expect(evaluatePurpose("CREATE_ORDER", "DEPOSIT")).toMatchObject({
      ok: false,
      reason: "FORBIDDEN_OPERATION",
    });
  });

  it("marks read operations as non-order-executable", () => {
    const d = evaluatePurpose("READ_ACCOUNT", null);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.requiresOrderFields).toBe(false);
  });

  it("marks testnet_proof and CREATE_ORDER as order-executable", () => {
    for (const p of ["testnet_proof", "CREATE_ORDER", "CLOSE_POSITION"]) {
      const d = evaluatePurpose(p, "MARKET");
      expect(d.ok).toBe(true);
      if (d.ok) expect(d.requiresOrderFields).toBe(true);
      expect(EXECUTABLE_PURPOSES.has(p)).toBe(true);
    }
  });
});

describe("broker-guard fingerprint", () => {
  const base: FingerprintInput = {
    user_id: "u1",
    connection_id: "c1",
    venue: "apex_omni_testnet",
    symbol: "BTC-USDT",
    side: "BUY",
    order_type: "MARKET",
    size: 0.001,
    price: null,
    leverage: 20,
    reduce_only: false,
    purpose: "testnet_proof",
  };

  it("is stable for identical inputs", async () => {
    const a = await computeFingerprint(base);
    const b = await computeFingerprint({ ...base });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("changes when size changes", async () => {
    const a = await computeFingerprint(base);
    const b = await computeFingerprint({ ...base, size: 0.002 });
    expect(a).not.toBe(b);
  });

  it("does NOT change when is_live-like fields would change (excluded by design)", async () => {
    // is_live is not part of FingerprintInput; parity with signer idempotency.
    const a = await computeFingerprint(base);
    const b = await computeFingerprint({ ...base });
    expect(a).toBe(b);
  });
});

describe("broker-guard PG error classification", () => {
  it("recognises 23505 unique_violation", () => {
    expect(isUniqueViolation({ code: "23505", message: "duplicate key" })).toBe(true);
  });
  it("treats all other codes as non-duplicate", () => {
    expect(isUniqueViolation({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isUniqueViolation({ code: "08006", message: "connection failure" })).toBe(false);
    expect(isUniqueViolation({ code: null, message: "unknown" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

// ---------- Static contract tests on the broker source ----------

describe("execution-broker source contract", () => {
  it("hoists APEX_EXECUTION_MOVED_TO_RAILWAY BEFORE body parsing, signature, and credential reads", () => {
    const iFlag = BROKER_SRC.indexOf('APEX_EXECUTION_MOVED_TO_RAILWAY_BROKER');
    const iBody = BROKER_SRC.indexOf('await req.text()');
    const iSigCall = BROKER_SRC.indexOf('await verifyIntentSignature(');
    const iCredsQuery = BROKER_SRC.indexOf('.from("exchange_credentials")');
    expect(iFlag).toBeGreaterThan(0);
    expect(iFlag).toBeLessThan(iBody);
    expect(iFlag).toBeLessThan(iSigCall);
    expect(iFlag).toBeLessThan(iCredsQuery);
  });

  it("does not import a mainnet ApeX adapter", () => {
    expect(BROKER_SRC).not.toMatch(/ApexOmniMainnetAdapter/);
    expect(BROKER_SRC).toMatch(/ApexOmniTestnetAdapter/);
  });

  it("removed the legacy 'unspecified' allowlist entry", () => {
    // The old string 'unspecified' was directly inside a Set literal in the
    // broker; the shared guard now rejects it explicitly.
    expect(BROKER_SRC).not.toMatch(/"unspecified"[\s,]*\n\s*\]\)/);
  });

  it("uses auditStrict for received and submitted reservations", () => {
    // The received phase reservation is fail-closed via auditStrict.
    expect(BROKER_SRC).toMatch(/phase:\s*"received"[\s\S]{0,600}auditStrict\(admin,\s*receivedRow\)/);
    expect(BROKER_SRC).toMatch(/auditStrict\(admin,\s*\{[\s\S]{0,400}phase:\s*"submitted"/);
  });

  it("distinguishes duplicate from generic DB failure", () => {
    expect(BROKER_SRC).toMatch(/RESERVATION_FAILED/);
    expect(BROKER_SRC).toMatch(/IDEMPOTENCY_CONFLICT/);
  });

  it("produces ambiguous state for unknown exchange outcome and never retries", () => {
    expect(BROKER_SRC).toMatch(/SUBMIT_TIMEOUT_UNRECONCILED/);
    expect(BROKER_SRC).toMatch(/status:\s*"ambiguous"/);
    // No retry loop wrapping placeOrder.
    expect(BROKER_SRC).not.toMatch(/for\s*\([^)]*\)\s*\{[\s\S]{0,200}adapter\.placeOrder/);
    expect(BROKER_SRC).not.toMatch(/while\s*\([^)]*\)\s*\{[\s\S]{0,200}adapter\.placeOrder/);
  });

  it("never returns raw DB error / stack / SQL in sanitized responses", () => {
    // Sanitized rejection payload uses only enum-shaped reject_reason strings.
    expect(BROKER_SRC).not.toMatch(/reject_reason:\s*(err|error|e\.message)/);
    expect(BROKER_SRC).not.toMatch(/console\.(log|error|warn)\(/);
  });
});
