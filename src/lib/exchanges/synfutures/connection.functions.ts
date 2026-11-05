import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertLegacyExecutionDisabled } from "@/lib/quorumark-mvp-policy.server";

const input = z.object({ walletId: z.string().uuid() }).strict();
const columns =
  "id,user_id,exchange,environment,status,permission_read,permission_trade,permissions_verified,is_live,permission_scopes";

export const readSynFuturesConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => input.parse(value))
  .handler(async ({ context: { supabase, userId }, data }) => {
    const registration = await supabase
      .from("synfutures_account_registrations")
      .select("id")
      .eq("user_id", userId)
      .eq("wallet_id", data.walletId)
      .maybeSingle();
    if (registration.error) throw new Error("Account connection unavailable. Retry.");
    if (!registration.data) return null;
    const result = await supabase
      .from("exchange_connections")
      .select(columns)
      .eq("id", registration.data.id)
      .eq("user_id", userId)
      .eq("exchange", "synfutures")
      .eq("environment", "mainnet")
      .maybeSingle();
    if (result.error) throw new Error("Account connection unavailable. Retry.");
    return result.data;
  });

/** Connect account reads only. No wallet transaction or trading authority is granted. */
export const connectSynFuturesAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => input.parse(value))
  .handler(async ({ context: { supabase, userId }, data }) => {
    assertLegacyExecutionDisabled("synfutures-connection");
    const role = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
    if (role.error || role.data !== true) throw new Error("OWNER_OR_ADMIN_REQUIRED");
    const wallet = await supabase
      .from("wallet_connections")
      .select("public_address")
      .eq("id", data.walletId)
      .eq("user_id", userId)
      .eq("status", "verified")
      .eq("is_active", true)
      .eq("chain", "ethereum")
      .eq("network", "mainnet")
      .maybeSingle();
    if (wallet.error || !wallet.data) throw new Error("VERIFIED_WALLET_REQUIRED");
    const registration = await supabase
      .from("synfutures_account_registrations")
      .select(
        "id,wallet_id,chain_id,owner_address,safe_address,module_address,safe_proxy_code_hash,module_code_hash",
      )
      .eq("user_id", userId)
      .eq("wallet_id", data.walletId)
      .maybeSingle();
    const saved = registration.data;
    if (
      registration.error ||
      !saved ||
      saved.chain_id !== 8453 ||
      saved.owner_address !== wallet.data.public_address.toLowerCase()
    ) {
      throw new Error("REGISTERED_ACCOUNT_REQUIRED");
    }
    const { attestSynFuturesAccount } = await import("./registration.server");
    let proof: Awaited<ReturnType<typeof attestSynFuturesAccount>>;
    try {
      proof = await attestSynFuturesAccount(wallet.data.public_address, data.walletId);
    } catch {
      throw new Error("Base account verification unavailable. Retry; no connection was changed.");
    }
    if (
      proof.ownerAddress.toLowerCase() !== saved.owner_address ||
      proof.safeAddress.toLowerCase() !== saved.safe_address ||
      proof.moduleAddress.toLowerCase() !== saved.module_address ||
      proof.safeProxyCodeHash !== saved.safe_proxy_code_hash ||
      proof.moduleCodeHash !== saved.module_code_hash
    ) {
      throw new Error("Registered account identity changed. Reverify it before connecting.");
    }
    const scope = {
      wallet_id: data.walletId,
      registration_id: saved.id,
      chain_id: 8453,
      owner_address: saved.owner_address,
      safe_address: saved.safe_address,
      module_address: saved.module_address,
      read_only: true,
      observed_block: proof.blockNumber,
      observed_block_hash: proof.blockHash,
    };
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      // Stable registration UUID makes retries and concurrent clicks idempotent.
      // Ignore conflicts first; never overwrite a different owner or venue.
      const created = await supabaseAdmin.from("exchange_connections").upsert(
        {
          id: saved.id,
          user_id: userId,
          exchange: "synfutures",
          environment: "mainnet",
          display_name: "SynFutures",
          status: "verified",
          market_type: "futures",
          permission_read: true,
          permission_trade: false,
          permissions_verified: false,
          withdrawals_disabled: true,
          is_live: false,
          permission_scopes: scope,
          last_verified_at: proof.blockTime,
        },
        { onConflict: "id", ignoreDuplicates: true },
      );
      if (created.error) throw new Error("Connection insert rejected");
      const existing = await supabaseAdmin
        .from("exchange_connections")
        .select(columns)
        .eq("id", saved.id)
        .eq("user_id", userId)
        .eq("exchange", "synfutures")
        .eq("environment", "mainnet")
        .maybeSingle();
      const row = existing.data;
      const metadata = row?.permission_scopes as Record<string, unknown> | null;
      if (
        existing.error ||
        !row ||
        metadata?.registration_id !== saved.id ||
        metadata?.wallet_id !== data.walletId ||
        metadata?.safe_address !== saved.safe_address
      ) {
        throw new Error("Connection binding mismatch");
      }
      if (row.is_live || row.permission_trade || row.permissions_verified) {
        if (
          row.is_live !== true ||
          row.permission_trade !== true ||
          row.permissions_verified !== true ||
          metadata?.read_only !== false ||
          typeof metadata?.operator_address !== "string" ||
          !/^0x[0-9a-f]{40}$/i.test(metadata.operator_address)
        )
          throw new Error("Connection binding mismatch");
        // Refresh account reads without downgrading or granting trading authority.
        const refreshed = await supabaseAdmin
          .from("exchange_connections")
          .update({
            permission_read: true,
            last_verified_at: proof.blockTime,
            last_error: null,
            last_error_code: null,
            last_error_message: null,
          })
          .eq("id", saved.id)
          .eq("user_id", userId)
          .eq("exchange", "synfutures")
          .eq("environment", "mainnet")
          .select(columns)
          .single();
        if (refreshed.error || !refreshed.data) throw new Error("Connection refresh unconfirmed");
        return refreshed.data;
      }
      const updated = await supabaseAdmin
        .from("exchange_connections")
        .update({
          status: "verified",
          permission_read: true,
          last_verified_at: proof.blockTime,
          last_error: null,
          last_error_code: null,
          last_error_message: null,
          permission_scopes: scope,
        })
        .eq("id", saved.id)
        .eq("user_id", userId)
        .eq("exchange", "synfutures")
        .eq("environment", "mainnet")
        .eq("is_live", false)
        .eq("permission_trade", false)
        .select(columns)
        .single();
      if (
        updated.error ||
        !updated.data ||
        updated.data.status !== "verified" ||
        updated.data.permission_read !== true ||
        updated.data.is_live ||
        updated.data.permission_trade ||
        updated.data.permissions_verified
      ) {
        throw new Error("Connection not confirmed");
      }
      return updated.data;
    } catch {
      throw new Error(
        "SynFutures connection could not be confirmed. Refresh account status before retrying.",
      );
    }
  });
