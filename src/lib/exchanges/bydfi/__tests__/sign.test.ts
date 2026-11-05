import { describe, expect, it } from "vitest";
import { signBydfi, bydfiCanonicalMessage, bydfiAuthHeaders } from "../sign";

/**
 * Signing fixture — deterministic. Reproduces BYDFi's official signing
 * algorithm from developers.bydfi.com/en/signature.
 *
 *   sign = HMAC_SHA256_hex(secret, accessKey + timestampMs + queryString + body)
 */
const FIXTURE = {
  accessKey: "ak_test_00000000000000000000",
  secret: "sk_test_secret_never_real",
  timestampMs: 1_700_000_000_000,
  queryString: "account=UMFUTURE",
  body: "",
};
const EXPECTED_MESSAGE =
  "ak_test_00000000000000000000" + "1700000000000" + "account=UMFUTURE" + "";

describe("bydfi/sign", () => {
  it("assembles the canonical message per official spec", () => {
    expect(bydfiCanonicalMessage(FIXTURE)).toBe(EXPECTED_MESSAGE);
  });

  it("produces a stable 64-char hex HMAC-SHA256 signature", async () => {
    const sig = await signBydfi(FIXTURE);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    // Determinism — same input → same output
    const sig2 = await signBydfi(FIXTURE);
    expect(sig2).toBe(sig);
  });

  it("differs when accessKey, timestamp, query, or body changes", async () => {
    const base = await signBydfi(FIXTURE);
    const variants = await Promise.all([
      signBydfi({ ...FIXTURE, accessKey: "different_key_00000000000000" }),
      signBydfi({ ...FIXTURE, timestampMs: FIXTURE.timestampMs + 1 }),
      signBydfi({ ...FIXTURE, queryString: "account=SPOT" }),
      signBydfi({ ...FIXTURE, body: '{"x":1}' }),
    ]);
    for (const v of variants) expect(v).not.toBe(base);
  });

  it("emits the exact BYDFi header names (X-API-KEY / -TIMESTAMP / -SIGNATURE)", async () => {
    const h = await bydfiAuthHeaders(FIXTURE);
    expect(h["X-API-KEY"]).toBe(FIXTURE.accessKey);
    expect(h["X-API-TIMESTAMP"]).toBe(String(FIXTURE.timestampMs));
    expect(h["X-API-SIGNATURE"]).toMatch(/^[0-9a-f]{64}$/);
    expect(h["Content-Type"]).toBe("application/json");
  });
});
