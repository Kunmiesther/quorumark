import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { synFuturesSetupInput } from "./setup";
import { assertLegacyExecutionDisabled } from "@/lib/quorumark-mvp-policy.server";

const columns = "id,wallet_id,allocation_usdc,max_leverage,chain_id,status,revision,updated_at";

export const readSynFuturesSetup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ walletId: z.string().uuid() }).strict().parse(input),
  )
  .handler(async ({ context: { supabase, userId }, data }) => {
    const result = await supabase
      .from("synfutures_setup_drafts")
      .select(columns)
      .eq("user_id", userId)
      .eq("wallet_id", data.walletId)
      .maybeSingle();
    if (result.error)
      throw new Error("Saved SynFutures setup is unavailable. Retry before editing.");
    return result.data;
  });

export const saveSynFuturesSetup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => synFuturesSetupInput.parse(input))
  .handler(async ({ context: { supabase, userId }, data }) => {
    assertLegacyExecutionDisabled("synfutures-setup");
    const admin = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
    if (admin.error || admin.data !== true) throw new Error("OWNER_OR_ADMIN_REQUIRED");
    const wallet = await supabase
      .from("wallet_connections")
      .select("id")
      .eq("id", data.walletId)
      .eq("user_id", userId)
      .eq("status", "verified")
      .eq("is_active", true)
      .eq("chain", "ethereum")
      .eq("network", "mainnet")
      .maybeSingle();
    if (wallet.error || !wallet.data)
      throw new Error("Select your verified active mainnet EVM wallet.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Numeric conversion is bounded to the database's supported UI amount range.
    const settings = {
      allocation_usdc: Number(data.allocationUsdc),
      max_leverage: data.maxLeverage,
    };
    const result =
      data.expectedRevision === 0
        ? await supabaseAdmin
            .from("synfutures_setup_drafts")
            .insert({
              ...settings,
              user_id: userId,
              wallet_id: data.walletId,
            })
            .select(columns)
            .single()
        : await supabaseAdmin
            .from("synfutures_setup_drafts")
            .update(settings)
            .eq("user_id", userId)
            .eq("wallet_id", data.walletId)
            .eq("revision", data.expectedRevision)
            .select(columns)
            .maybeSingle();
    if (result.error?.code === "23505" || (!result.error && !result.data)) {
      throw new Error(
        "Setup changed in another session. Reload the saved setup before saving again.",
      );
    }
    if (result.error || !result.data)
      throw new Error(
        "Setup could not be saved. Recheck your wallet and retry; trading was not changed.",
      );
    return result.data;
  });
