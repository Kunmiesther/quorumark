import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { synFuturesRegistration } from "./registration";
import { assertLegacyExecutionDisabled } from "@/lib/quorumark-mvp-policy.server";

/** Owner-scoped history only; never registers or refreshes on-chain authority. */
export const readSynFuturesRegistration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ walletId: z.string().uuid() }).strict().parse(input),
  )
  .handler(async ({ context: { supabase, userId }, data }) => {
    const result = await supabase
      .from("synfutures_account_registrations")
      .select(
        "id,wallet_id,setup_revision,chain_id,owner_address,safe_address,module_address,status,verified_at",
      )
      .eq("user_id", userId)
      .eq("wallet_id", data.walletId)
      .maybeSingle();
    if (result.error)
      throw new Error("Registration status unavailable. Reload before registering.");
    if (!result.data) return null;
    return synFuturesRegistration.parse({ ...result.data, execution_ready: false });
  });

/** Explicit registration command; existing read-only deployment checks stay read-only. */
export const registerSynFuturesAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        walletId: z.string().uuid(),
        expectedRevision: z.number().int().min(1).max(2147483647),
      })
      .strict()
      .parse(input),
  )
  .handler(async ({ context: { supabase, userId }, data }) => {
    assertLegacyExecutionDisabled("synfutures-registration");
    const admin = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
    if (admin.error || admin.data !== true) throw new Error("OWNER_OR_ADMIN_REQUIRED");
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
    const setup = await supabase
      .from("synfutures_setup_drafts")
      .select("revision")
      .eq("user_id", userId)
      .eq("wallet_id", data.walletId)
      .maybeSingle();
    if (setup.error || setup.data?.revision !== data.expectedRevision)
      throw new Error("SETUP_CHANGED_RELOAD_REQUIRED");
    // Wallet, addresses, code hashes, block proof and caller identity are never accepted from the browser.
    const { attestSynFuturesAccount } = await import("./registration.server");
    let proof;
    try {
      proof = await attestSynFuturesAccount(wallet.data.public_address, data.walletId);
    } catch {
      throw new Error(
        "SynFutures account verification failed. Check both deployments on Base and retry; no trading settings changed.",
      );
    }
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const result = await supabaseAdmin.rpc("register_synfutures_account", {
        p_user_id: userId,
        p_wallet_id: data.walletId,
        p_setup_revision: data.expectedRevision,
        p_owner_address: proof.ownerAddress,
        p_safe_address: proof.safeAddress,
        p_module_address: proof.moduleAddress,
        p_safe_proxy_code_hash: proof.safeProxyCodeHash,
        p_module_code_hash: proof.moduleCodeHash,
        p_block_number: proof.blockNumber,
        p_block_hash: proof.blockHash,
        p_block_time: proof.blockTime,
      });
      if (result.error || !result.data) throw new Error("Registration not confirmed");
      const registration = synFuturesRegistration.parse(result.data);
      if (
        registration.wallet_id !== data.walletId ||
        registration.setup_revision !== data.expectedRevision ||
        registration.owner_address !== proof.ownerAddress.toLowerCase() ||
        registration.safe_address !== proof.safeAddress.toLowerCase() ||
        registration.module_address !== proof.moduleAddress.toLowerCase()
      ) {
        throw new Error("Registration identity mismatch");
      }
      return registration;
    } catch {
      throw new Error(
        "SynFutures registration could not be confirmed. Recheck the saved setup and retry; trading was not enabled.",
      );
    }
  });
