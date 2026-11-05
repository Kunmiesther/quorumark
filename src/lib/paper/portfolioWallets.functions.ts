import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** One-time simulated capital only. Caller identity cannot be supplied as input. */
export const initializePaperPortfolio = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.rpc(
      "configure_six_paper_wallets" as never,
      {
        _user_id: context.userId,
      } as never,
    );
    if (error)
      throw new Error(
        "Paper funding could not be applied. Existing positions and balances were retained.",
      );
    return { ok: true };
  });
