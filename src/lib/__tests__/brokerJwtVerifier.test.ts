import { describe, expect, it, vi } from "vitest";

import { makeJwtVerifier } from "../../../broker/src/auth";

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "publishable-test-key",
  SUPABASE_JWT_ISSUER: "https://example.supabase.co/auth/v1",
  SUPABASE_JWKS_URL: "https://example.supabase.co/auth/v1/.well-known/jwks.json",
};

describe("broker bearer verification", () => {
  it("accepts an asymmetric token verified by JWKS", async () => {
    const verifyWithSupabase = vi.fn();
    const verify = makeJwtVerifier(env, {
      verifyWithJwks: async () => ({ sub: "user-jwks", email: "owner@example.com" }),
      verifyWithSupabase,
    });

    await expect(verify("Bearer signed-token")).resolves.toMatchObject({
      sub: "user-jwks",
      email: "owner@example.com",
    });
    expect(verifyWithSupabase).not.toHaveBeenCalled();
  });

  it("uses authoritative Supabase Auth for a valid legacy token with no public JWK", async () => {
    const verify = makeJwtVerifier(env, {
      verifyWithJwks: async () => {
        throw new Error("unsupported signing algorithm");
      },
      verifyWithSupabase: async (token) =>
        token === "legacy-token" ? { id: "user-legacy", email: "owner@example.com" } : null,
    });

    await expect(verify("Bearer legacy-token")).resolves.toMatchObject({
      sub: "user-legacy",
      email: "owner@example.com",
    });
  });

  it("still rejects a token that neither verifier validates", async () => {
    const verify = makeJwtVerifier(env, {
      verifyWithJwks: async () => {
        throw new Error("bad signature");
      },
      verifyWithSupabase: async () => null,
    });

    await expect(verify("Bearer invalid-token")).rejects.toThrow("INVALID_JWT");
  });

  it("rejects a missing bearer before either verifier runs", async () => {
    const verifyWithJwks = vi.fn();
    const verifyWithSupabase = vi.fn();
    const verify = makeJwtVerifier(env, { verifyWithJwks, verifyWithSupabase });

    await expect(verify(undefined)).rejects.toThrow("MISSING_BEARER");
    expect(verifyWithJwks).not.toHaveBeenCalled();
    expect(verifyWithSupabase).not.toHaveBeenCalled();
  });
});
