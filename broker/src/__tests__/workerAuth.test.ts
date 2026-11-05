import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { computeWorkerHmac, verifyWorkerRequest } from "../workerAuth";

const secret = "worker-order-secret-for-tests";
const timestamp = "2000000000";
const nonce = "a".repeat(32);
const path = "/v1/automation/orders";
const body = { z: 2, nested: { b: true, a: "x" }, a: 1 };

function verify(overrides: Partial<Parameters<typeof verifyWorkerRequest>[0]> = {}) {
  return verifyWorkerRequest({
    secret,
    timestamp,
    nonce,
    signature: computeWorkerHmac(secret, timestamp, nonce, path, body),
    path,
    body,
    nowSeconds: 2_000_000_000,
    seenNonces: new Map(),
    ...overrides,
  });
}

describe("worker automation HMAC", () => {
  it("verifies Python wire bytes without changing floats or Unicode", () => {
    const rawBody =
      '{"label":"\\u00e9","size":1079.0,"stop_pct":1e-07,"tp_tiers":[{"rr_multiple":2.0}]}';
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}\n${nonce}\n${path}\n${rawBody}`)
      .digest("hex");
    expect(verify({ body: JSON.parse(rawBody), signature })).toEqual({
      ok: false,
      code: "INVALID_AUTOMATION_SIGNATURE",
    });
    expect(
      verify({ body: JSON.parse(rawBody), rawBody, signature, signatureVersion: "raw-v1" }),
    ).toEqual({ ok: true });
    expect(
      verify({
        rawBody: rawBody.replace("1079.0", "1080.0"),
        signature,
        signatureVersion: "raw-v1",
      }),
    ).toEqual({ ok: false, code: "INVALID_AUTOMATION_SIGNATURE" });
    expect(verify({ signatureVersion: "raw-v1" })).toEqual({
      ok: false,
      code: "MISSING_AUTOMATION_RAW_BODY",
    });
    expect(verify({ signatureVersion: "unknown" })).toEqual({
      ok: false,
      code: "INVALID_AUTOMATION_SIGNATURE_VERSION",
    });
  });
  it("accepts canonical signed requests", () => {
    expect(verify()).toEqual({ ok: true });
  });

  it("rejects signature mismatch, clock skew, and replay", () => {
    expect(verify({ signature: "0".repeat(64) })).toEqual({
      ok: false,
      code: "INVALID_AUTOMATION_SIGNATURE",
    });
    expect(verify({ nowSeconds: 2_000_000_061 })).toEqual({
      ok: false,
      code: "AUTOMATION_TIMESTAMP_SKEW",
    });
    const seen = new Map<string, number>();
    expect(verify({ seenNonces: seen })).toEqual({ ok: true });
    expect(verify({ seenNonces: seen })).toEqual({ ok: false, code: "AUTOMATION_REPLAY" });
  });

  it("fails closed when the machine credential is absent", () => {
    expect(verify({ secret: null })).toEqual({
      ok: false,
      code: "AUTOMATION_AUTH_NOT_CONFIGURED",
    });
  });
});
