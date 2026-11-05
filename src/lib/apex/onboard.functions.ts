/**
 * Authenticated proxy to the private signer's /v1/onboard flow.
 *
 * Authorization model:
 *   1. requireSupabaseAuth middleware — caller must be signed in.
 *   2. Broker + signer validate the connection belongs to the caller.
 *
 * Runtime path:
 *   browser -> this server function -> broker /v1/onboard (JWT) -> signer /v1/onboard
 *
 * The wallet's EIP-191 signature is opaque credential material. We do not
 * log it, we do not persist it on the way through, and the signer is the
 * only process allowed to derive the zk seed from it.
 *
 * Response is the broker's sanitized envelope — credential_id, fingerprint,
 * environment — never derived secrets.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertLegacyExecutionDisabled } from "@/lib/quorumark-mvp-policy.server";

type OnboardInput = {
  connection_id: string;
  wallet_address: string;
  environment: "mainnet" | "testnet";
  signature: string;
};

export type OnboardResult = {
  ok: true;
  credential_id: string | null;
  credential_fingerprint: string | null;
  environment: string | null;
};

export const signerOnboard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown): OnboardInput => {
    const i = input as Partial<OnboardInput> | null | undefined;
    if (!i || typeof i !== "object") throw new Error("INVALID_INPUT");
    const wallet = String(i.wallet_address ?? "");
    const env = String(i.environment ?? "");
    const conn = String(i.connection_id ?? "");
    const sig = String(i.signature ?? "");
    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) throw new Error("INVALID_WALLET");
    if (env !== "mainnet" && env !== "testnet") throw new Error("INVALID_ENVIRONMENT");
    if (!/^[0-9a-fA-F-]{16,64}$/.test(conn)) throw new Error("INVALID_CONNECTION_ID");
    if (sig.length < 10 || sig.length > 200) throw new Error("INVALID_SIGNATURE_SHAPE");
    return { connection_id: conn, wallet_address: wallet, environment: env, signature: sig };
  })
  .handler(async ({ data: input, context }): Promise<OnboardResult> => {
    assertLegacyExecutionDisabled("signer-onboard");
    const brokerUrl = process.env.TURTLE_BROKER_BASE_URL;
    if (!brokerUrl) throw new Error("BROKER_NOT_CONFIGURED");

    // The bearer that authenticated this server function is the same one
    // the broker needs to authorize the caller. Read it from the inbound
    // request rather than context (middleware doesn't expose the raw
    // token; this avoids re-plumbing that surface).
    const authHeader = getRequestHeader("authorization") ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) throw new Error("MISSING_BEARER");
    const bearer = authHeader.slice(7).trim();
    if (!bearer) throw new Error("MISSING_BEARER");

    const url = `${brokerUrl.replace(/\/$/, "")}/v1/onboard`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify(input),
      });
    } catch {
      throw new Error("BROKER_UNREACHABLE");
    }

    const text = await res.text();
    let body: { ok?: boolean; error?: string; data?: unknown } | null = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!res.ok || !body?.ok) {
      const err =
        (body && (body.error || (body as { detail?: string }).detail)) || `HTTP_${res.status}`;
      throw new Error(String(err));
    }

    const d = (body.data ?? {}) as Record<string, unknown>;
    const now = new Date().toISOString();
    const liveEnvironment = input.environment === "mainnet" ? "production" : "testnet";
    // The browser-authenticated client is deliberately allowed to update only
    // `exchange_connections.is_live`. Trading permission is a server-attested
    // fact, so promoting the connection with context.supabase is rejected by
    // the column grant/RLS policy after the broker has already onboarded the
    // wallet. Use the isolated server admin client only after the broker has
    // verified ownership and returned a successful onboarding result, and
    // continue to scope every write to the authenticated user.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: promotedConnection, error: connUpdateError } = await supabaseAdmin
      .from("exchange_connections")
      .update({
        environment: liveEnvironment,
        status: "verified",
        permission_read: true,
        permission_trade: true,
        permissions_verified: true,
        permission_verified_at: now,
        last_verified_at: now,
        last_health_check_at: now,
        last_error_code: null,
        last_error_message: null,
      })
      .eq("id", input.connection_id)
      .eq("user_id", context.userId)
      .select("id")
      .maybeSingle();
    if (connUpdateError || !promotedConnection) {
      throw new Error("ACTIVATION_STATE_UPDATE_FAILED");
    }

    if (input.environment === "mainnet") {
      const { data: updatedStrategy, error: strategyUpdateError } = await supabaseAdmin
        .from("user_strategy")
        .update({
          enabled: true,
          mode: "live",
          cross_margin: true,
          margin_mode: "cross",
          updated_at: now,
        })
        .eq("user_id", context.userId)
        .eq("connection_id", input.connection_id)
        .select("user_id")
        .maybeSingle();
      if (strategyUpdateError) throw new Error("ACTIVATION_STRATEGY_UPDATE_FAILED");

      let strategyReady = Boolean(updatedStrategy);
      if (!strategyReady) {
        // Legacy production accounts can have the original one-row strategy
        // record with no connection_id. Claim that owned row before trying an
        // insert, otherwise the original user_id primary key rejects a safe
        // re-activation as a duplicate.
        const { data: claimedStrategy, error: claimError } = await supabaseAdmin
          .from("user_strategy")
          .update({
            connection_id: input.connection_id,
            enabled: true,
            mode: "live",
            cross_margin: true,
            margin_mode: "cross",
            updated_at: now,
          })
          .eq("user_id", context.userId)
          .is("connection_id", null)
          .select("user_id")
          .maybeSingle();
        if (claimError) throw new Error("ACTIVATION_STRATEGY_CLAIM_FAILED");
        strategyReady = Boolean(claimedStrategy);
      }

      if (!strategyReady) {
        const { data: strategy } = await supabaseAdmin
          .from("strategies")
          .select("id")
          .eq("slug", "dca")
          .maybeSingle();
        if (strategy?.id) {
          const { error: strategyInsertError } = await supabaseAdmin.from("user_strategy").insert({
            user_id: context.userId,
            connection_id: input.connection_id,
            strategy_id: strategy.id,
            market_type: "spot",
            cross_margin: true,
            margin_mode: "cross",
            enabled: true,
            mode: "live",
            params: {},
            hedge_guard: {},
            updated_at: now,
          });
          if (strategyInsertError) throw new Error("ACTIVATION_STRATEGY_INSERT_FAILED");
        }
      }
    }

    return {
      ok: true,
      credential_id: (d.credential_id as string) ?? null,
      credential_fingerprint: (d.credential_fingerprint as string) ?? null,
      environment: (d.environment as string) ?? null,
    };
  });
