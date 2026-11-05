import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const inspectSynFuturesDeployment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        walletId: z.string().uuid(),
        pending: z
          .object({
            stage: z.enum(["deploy_safe", "deploy_module"]),
            hash: z
              .string()
              .regex(/^0x[0-9a-f]{64}$/i)
              .transform((v) => v as `0x${string}`),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(input),
  )
  .handler(async ({ context: { supabase, userId }, data }) => {
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
    if (wallet.error || !wallet.data)
      throw new Error("Select your verified active mainnet EVM wallet.");
    const setup = await supabase
      .from("synfutures_setup_drafts")
      .select("id")
      .eq("wallet_id", data.walletId)
      .eq("user_id", userId)
      .maybeSingle();
    if (setup.error || !setup.data)
      throw new Error("Save your SynFutures allocation and leverage setup first.");
    const { inspectSynDeployment } = await import("./deployment.server");
    try {
      return await inspectSynDeployment(wallet.data.public_address, data.walletId, data.pending);
    } catch {
      throw new Error(
        "Could not verify the Base deployment. No transaction was sent. Retry the read-only check.",
      );
    }
  });
