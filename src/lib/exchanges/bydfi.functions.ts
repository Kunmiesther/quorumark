/**
 * BYDFi server functions — user-facing entry points for the BYDFi connection.
 *
 * IMPORTANT: This file is client-reachable (any component may import it), so
 * server-only modules (crypto, adapter, service role client) are dynamically
 * imported inside handlers only.
 *
 * No order / trade endpoint is reachable from here. The only writes performed
 * are:
 *   - `exchange_connections` row (status transitions)
 *   - `exchange_credentials` (encrypted at rest, redacted in all responses)
 *   - `venue_capabilities` (per-connection handshake result)
 *   - `bydfi_verified_universe` (verified instrument cache)
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertLegacyExecutionDisabled } from "@/lib/quorumark-mvp-policy.server";

const ConnectInput = z.object({
  apiKey: z.string().trim().min(8).max(256),
  apiSecret: z.string().trim().min(8).max(512),
  environment: z.enum(["mainnet", "testnet"]).default("mainnet"),
});

export const connectAndVerifyBydfi = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => ConnectInput.parse(data))
  .handler(async ({ data, context }) => {
    assertLegacyExecutionDisabled("bydfi-credential-connect");
    const { supabase, userId } = context;
    const [{ encryptSecret }, { bydfiReadOnlyHandshake }] = await Promise.all([
      import("./bydfi/crypto.server"),
      import("./bydfi/adapter.server"),
    ]);
    const { redactObject } = await import("./bydfi/redact");

    // 1. Create/reset the connection row in VERIFYING state.
    const upsertConn = await supabase
      .from("exchange_connections")
      .upsert(
        {
          user_id: userId,
          exchange: "bydfi",
          environment: data.environment,
          status: "verifying",
          withdrawals_disabled: true,
          permission_read: true,
          permission_trade: false,
          permissions_verified: false,
          last_error_code: null,
          last_error_message: null,
        },
        { onConflict: "user_id,exchange", ignoreDuplicates: false },
      )
      .select("id")
      .single();
    if (upsertConn.error || !upsertConn.data) {
      return {
        ok: false,
        error: { code: "storage", message: "Could not create BYDFi connection row." },
      };
    }
    const connectionId = upsertConn.data.id as string;

    // 2. Handshake BEFORE persisting the credential (avoids storing a bad key).
    const handshake = await bydfiReadOnlyHandshake({
      accessKey: data.apiKey,
      secret: data.apiSecret,
    });

    if (!handshake.ok) {
      await supabase
        .from("exchange_connections")
        .update({
          status:
            handshake.error?.code === "invalid_credentials" ||
            handshake.error?.code === "signature_rejected"
              ? "error"
              : "needs_attention",
          last_error_code: handshake.error?.code ?? "unknown",
          last_error_message: handshake.error?.message?.slice(0, 500) ?? null,
        })
        .eq("id", connectionId);
      return {
        ok: false,
        error: redactObject(handshake.error ?? { code: "unknown", message: "handshake failed" }),
      };
    }

    // 3. Encrypt + persist credentials via admin client (RLS bypass justified:
    //    caller identity was verified by requireSupabaseAuth; write is scoped
    //    to the caller's own connection_id/user_id).
    const [encKey, encSecret] = await Promise.all([
      encryptSecret(data.apiKey),
      encryptSecret(data.apiSecret),
    ]);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const credUpsert = await supabaseAdmin.from("exchange_credentials").upsert(
      {
        connection_id: connectionId,
        user_id: userId,
        encrypted_api_key: encKey,
        encrypted_api_secret: encSecret,
        encryption_version: 2,
        rotated_at: new Date().toISOString(),
      },
      { onConflict: "connection_id" },
    );
    if (credUpsert.error) {
      return {
        ok: false,
        error: { code: "storage", message: "Could not persist encrypted credentials." },
      };
    }

    // 4. Persist verified capability record. `withdrawal_disabled` is
    //    UNVERIFIED via API — flagged explicitly, never claimed as verified.
    const capabilities = {
      auth: { verified: true },
      instruments_count: handshake.instruments?.length ?? 0,
      margin_modes: { cross: true, isolated: true, verified_via: "static_registry" },
      position_mode: "one_way",
      max_leverage_per_symbol_verified: true,
      withdrawal_permission: {
        verified: false,
        reason:
          "BYDFi /account/assets does not expose withdrawal scope; owner must confirm at key creation.",
      },
      trade_permission: { verified: false, reason: "Not required for read-only verification." },
    };

    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + handshake.ttlMs).toISOString();
    await supabase.from("venue_capabilities").upsert(
      {
        user_id: userId,
        connection_id: connectionId,
        exchange: "bydfi",
        adapter_version: "bydfi-v1",
        environment: data.environment,
        market_type: "futures",
        position_mode: "one_way",
        symbol: null,
        capabilities,
        source: "handshake",
        verification_status: "verified",
        retrieved_at: nowIso,
        expires_at: expiresIso,
      },
      {
        onConflict:
          "exchange,adapter_version,environment,market_type,position_mode,symbol,connection_id,user_id",
      },
    );

    // 5. Cache the verified instrument universe for this connection.
    if (handshake.instruments && handshake.instruments.length > 0) {
      const rows = handshake.instruments.map((i) => ({
        user_id: userId,
        connection_id: connectionId,
        symbol: i.symbol,
        venue_symbol: i.venueSymbol,
        base: i.base,
        quote: i.quote,
        tradable: i.tradable,
        max_leverage: i.maxLeverage,
        tick_size: i.tickSize,
        min_qty: i.minQty,
        min_notional: i.minNotional,
        volume_24h_usd: i.volume24hUsd,
        verified_at: nowIso,
      }));
      // Chunked insert to stay within statement size limits. Cast to any:
      // the `bydfi_verified_universe` table is created in a paired migration
      // and the generated Database types are refreshed post-approval.
      const CHUNK = 200;
      const adminAny = supabaseAdmin as unknown as {
        from: (t: string) => {
          upsert: (r: unknown[], o: { onConflict: string }) => Promise<unknown>;
        };
      };
      for (let i = 0; i < rows.length; i += CHUNK) {
        await adminAny
          .from("bydfi_verified_universe")
          .upsert(rows.slice(i, i + CHUNK), { onConflict: "connection_id,symbol" });
      }
    }

    // 6. Mark connection CONNECTED but NOT trade-ready.
    await supabase
      .from("exchange_connections")
      .update({
        status: "verified",
        permissions_verified: false, // withdrawal scope explicitly unverified
        permission_verified_at: nowIso,
        last_verified_at: nowIso,
        last_health_check_at: nowIso,
        last_error_code: null,
        last_error_message: null,
      })
      .eq("id", connectionId);

    return {
      ok: true,
      connectionId,
      state: "CAPABILITIES_VERIFIED",
      trade_ready: false, // execution flag globally disabled
      verified_at: nowIso,
      expires_at: expiresIso,
      instruments_count: handshake.instruments?.length ?? 0,
      withdrawal_permission_verified: false,
    };
  });

export const getBydfiConnectionStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const conn = await supabase
      .from("exchange_connections")
      .select("id,status,environment,last_verified_at,last_error_code,last_error_message")
      .eq("user_id", userId)
      .eq("exchange", "bydfi")
      .maybeSingle();
    const cap = conn.data
      ? await supabase
          .from("venue_capabilities")
          .select("verification_status,capabilities,retrieved_at,expires_at")
          .eq("connection_id", conn.data.id)
          .eq("exchange", "bydfi")
          .order("retrieved_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : null;
    return {
      connection: conn.data ?? null,
      capability: cap?.data ?? null,
      trade_ready: false,
    };
  });
