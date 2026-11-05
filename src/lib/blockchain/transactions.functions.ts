import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { prepareSwapSchema, receiptRequestSchema } from "./transactions";
import { spotRequestSchema } from "./spot";
import { assertLegacyExecutionDisabled } from "@/lib/quorumark-mvp-policy.server";

export const prepareBlockchainSwap = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => prepareSwapSchema.parse(v))
  .handler(async ({ data, context }) => {
    assertLegacyExecutionDisabled("blockchain-swap-prepare");
    const m = await import("./transactions.server");
    const { requestId, ...request } = data;
    return m.safeSwapCall(() =>
      m.prepareSwapRecord(context, requestId, spotRequestSchema.parse(request)),
    );
  });
export const claimBlockchainSwap = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: z.string().uuid() }).strict().parse(v))
  .handler(async ({ data, context }) => {
    assertLegacyExecutionDisabled("blockchain-swap-claim");
    const m = await import("./transactions.server");
    return m.safeSwapCall(() => m.claimSwapRecord(context, data.id));
  });
export const trackBlockchainSwap = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => receiptRequestSchema.parse(v))
  .handler(async ({ data, context }) => {
    assertLegacyExecutionDisabled("blockchain-swap-track");
    const m = await import("./transactions.server");
    return m.safeSwapCall(() => m.trackSwapRecord(context, data.id, data.hash as `0x${string}`));
  });
export const listBlockchainSwaps = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) =>
    z
      .object({ walletId: z.string().uuid(), network: z.enum(["base", "bnb"]) })
      .strict()
      .parse(v),
  )
  .handler(async ({ data, context }) => {
    const m = await import("./transactions.server");
    return m.listSwapRecords(context, data.walletId, data.network);
  });
export const declineBlockchainSwap = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: z.string().uuid() }).strict().parse(v))
  .handler(async ({ data, context }) => {
    assertLegacyExecutionDisabled("blockchain-swap-decline");
    const m = await import("./transactions.server");
    return m.declineSwapRecord(context, data.id);
  });
