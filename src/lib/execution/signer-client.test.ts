import { describe, it, expect, vi } from "vitest";

// Provide a Deno.env shim so the module loads under Node/vitest.
(globalThis as unknown as { Deno?: { env: { get: (k: string) => string | undefined } } }).Deno = {
  env: { get: (_k: string) => undefined },
};

import { forwardToSigner } from "../../../supabase/functions/_shared/signer-client";

const OPTS = {
  baseUrl: "https://signer.test",
  sharedSecret: "shh",
  timeoutMs: 500,
  now: () => 1_700_000_000_000,
  randomNonce: () => "deadbeef",
};

describe("signer-client forwardToSigner", () => {
  it("signs with HMAC headers and returns submitted on 200", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      expect(h.get("x-signer-timestamp")).toBeTruthy();
      expect(h.get("x-signer-nonce")).toBe("deadbeef");
      expect(h.get("x-signer-signature")).toMatch(/^[0-9a-f]{64}$/);
      return new Response(
        JSON.stringify({ status: "submitted", venue_order_id: "abc123" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const r = await forwardToSigner({ symbol: "BTC-USDT" }, { ...OPTS, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toMatchObject({ kind: "submitted", orderId: "abc123", status: "submitted" });
  });

  it("maps FastAPI HTTPException detail to reject code", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ detail: "SIGNER_DISABLED" }), { status: 403 }),
    );
    const r = await forwardToSigner({}, { ...OPTS, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toEqual(expect.objectContaining({ kind: "rejected", httpStatus: 403, code: "SIGNER_DISABLED" }));
  });

  it("returns ambiguous on abort/timeout — never retried by caller", async () => {
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      await new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => {
          const e = new Error("aborted"); (e as unknown as { name: string }).name = "AbortError"; reject(e);
        });
      });
      return new Response("");
    });
    const r = await forwardToSigner({}, { ...OPTS, timeoutMs: 5, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.kind).toBe("ambiguous");
    expect(r.reason).toBe("SIGNER_TIMEOUT");
  });

  it("returns unreachable when not configured", async () => {
    const r = await forwardToSigner({}, { baseUrl: "", sharedSecret: "" });
    expect(r).toEqual({ kind: "unreachable", reason: "SIGNER_NOT_CONFIGURED" });
  });

  it("2xx with unexpected shape is ambiguous, not submitted", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ hello: "world" }), { status: 200 }));
    const r = await forwardToSigner({}, { ...OPTS, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toEqual(expect.objectContaining({ kind: "ambiguous", reason: "SIGNER_RESPONSE_SHAPE_UNKNOWN" }));
  });
});
