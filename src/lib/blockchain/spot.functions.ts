import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { spotRequestSchema, tokenLookupSchema } from "./spot";

export const inspectBlockchainToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => tokenLookupSchema.parse(input))
  .handler(async ({ data }) => {
    const [{ inspectSpotToken }, { safeSwapCall }] = await Promise.all([
      import("./spot.server"),
      import("./transactions.server"),
    ]);
    return safeSwapCall(() => inspectSpotToken(data.network, data.address));
  });

export const inspectSpotSwap = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => spotRequestSchema.parse(input))
  .handler(async ({ data, context: { supabase, userId } }) => {
    const { data: wallet, error } = await supabase
      .from("wallet_connections")
      .select("id,chain,network,public_address,status,is_active,provider,label")
      .eq("user_id", userId)
      .eq("id", data.walletId)
      .eq("is_active", true)
      .eq("status", "verified")
      .maybeSingle();
    if (error || !wallet) throw new Error("Select your verified wallet before previewing a swap.");
    const [{ previewSpotSwap }, { BaseError }] = await Promise.all([
      import("./spot.server"),
      import("viem"),
    ]);
    try {
      return await previewSpotSwap(data, wallet);
    } catch (failure) {
      // viem errors may contain a provisioned RPC URL/API key. Never return them to the browser.
      if (failure instanceof BaseError)
        throw new Error(
          "Blockchain RPC unavailable. Retry the preflight; no transaction was sent.",
        );
      throw failure;
    }
  });
