import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { createClient } from "@supabase/supabase-js";

export type JwtVerifierEnv = {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_JWT_ISSUER: string;
  SUPABASE_JWKS_URL: string;
};

export type BearerIdentity = {
  sub: string;
  email?: string;
  claims: Record<string, unknown>;
};

type VerifiedSupabaseUser = {
  id: string;
  email?: string;
  claims?: Record<string, unknown>;
};

type VerifierDependencies = {
  verifyWithJwks?: (token: string) => Promise<JWTPayload>;
  verifyWithSupabase?: (token: string) => Promise<VerifiedSupabaseUser | null>;
};

function authError(code: "MISSING_BEARER" | "INVALID_JWT"): Error {
  return Object.assign(new Error(code), { statusCode: 401 });
}

/**
 * Verify a browser Supabase bearer without assuming one signing algorithm.
 *
 * Supabase projects can issue asymmetric JWTs (verified locally with JWKS) or
 * legacy/shared-secret JWTs. The latter cannot be verified by a remote JWKS,
 * so we fall back to Supabase Auth's authoritative getUser(token) endpoint.
 * Both paths cryptographically validate the token; the fallback is not a
 * decode-only path and never trusts client-provided identity fields.
 */
export function makeJwtVerifier(env: JwtVerifierEnv, deps: VerifierDependencies = {}) {
  const jwks = createRemoteJWKSet(new URL(env.SUPABASE_JWKS_URL));
  const authClient = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const verifyWithJwks =
    deps.verifyWithJwks ??
    (async (token: string) => {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: env.SUPABASE_JWT_ISSUER,
      });
      return payload;
    });

  const verifyWithSupabase =
    deps.verifyWithSupabase ??
    (async (token: string): Promise<VerifiedSupabaseUser | null> => {
      const { data, error } = await authClient.auth.getUser(token);
      if (error || !data.user?.id) return null;
      return {
        id: data.user.id,
        email: data.user.email,
        claims: {
          ...(data.user.app_metadata ?? {}),
          ...(data.user.user_metadata ?? {}),
        },
      };
    });

  return async function verifyBearer(auth: string | undefined): Promise<BearerIdentity> {
    if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
      throw authError("MISSING_BEARER");
    }
    const token = auth.slice(7).trim();
    if (!token) throw authError("MISSING_BEARER");

    try {
      const payload = await verifyWithJwks(token);
      if (!payload.sub) throw new Error("NO_SUB");
      return {
        sub: String(payload.sub),
        email: typeof payload.email === "string" ? payload.email : undefined,
        claims: payload as Record<string, unknown>,
      };
    } catch {
      // Shared-secret/legacy Supabase access tokens do not have a public JWK.
      // Ask Supabase Auth to validate the token and return its authoritative
      // user instead of rejecting an otherwise valid signed-in owner.
    }

    try {
      const user = await verifyWithSupabase(token);
      if (!user?.id) throw new Error("NO_USER");
      return {
        sub: user.id,
        email: user.email,
        claims: user.claims ?? {},
      };
    } catch {
      throw authError("INVALID_JWT");
    }
  };
}
