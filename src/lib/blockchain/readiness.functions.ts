import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { BLOCKCHAINS } from "./catalog";

export const inspectBlockchainWallet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        network: z.enum(["base", "solana", "robinhood", "bnb"]),
        walletId: z.string().uuid(),
      })
      .strict()
      .parse(input),
  )
  .handler(async ({ data, context: { supabase, userId } }) => {
    const { data: wallet, error } = await supabase
      .from("wallet_connections")
      .select("id,chain,network,public_address,status,is_active,provider,label")
      .eq("user_id", userId)
      .eq("id", data.walletId)
      .eq("is_active", true)
      .eq("status", "verified")
      .maybeSingle();
    if (error || !wallet) throw new Error("VERIFIED_WALLET_REQUIRED");
    const network = BLOCKCHAINS.find((chain) => chain.id === data.network)!;
    const { inspectNetworkWallet } = await import("./readiness.server");
    try {
      return await inspectNetworkWallet(network, wallet);
    } catch {
      throw new Error(
        "Network check unavailable. Confirm the wallet network and retry. No transaction was sent.",
      );
    }
  });
