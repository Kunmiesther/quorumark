import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const manualCouncilDraft = z.object({
  book: z.enum(["paper", "live"]),
  exchange: z.string().max(40),
  connectionId: z.string().uuid().nullable().optional(),
  symbol: z
    .string()
    .regex(/^[A-Z0-9]+[-/]?[A-Z0-9]+$/)
    .max(24),
  side: z.enum(["long", "short"]),
  leverage: z.number().finite().positive(),
  margin: z.number().finite().nonnegative().nullable(),
  size: z.number().finite().positive().optional(),
  kind: z.enum(["market", "limit"]),
  limitPrice: z.number().finite().positive().nullable(),
  takeProfit: z.number().finite().positive().nullable(),
  stopLoss: z.number().finite().positive().nullable(),
  dca: z.boolean(),
  rungCount: z.number().int().positive().max(20),
  spacingPct: z.number().finite().nonnegative(),
  rungMargins: z.array(z.number().finite().nonnegative()).max(20).nullable().optional(),
  takeProfitPerRung: z.boolean().optional(),
});
export type ManualCouncilDraft = z.infer<typeof manualCouncilDraft>;

/** Advisory only. No signer, order endpoint, or exchange credentials. */
export const reviewManualTicket = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => manualCouncilDraft.parse(input))
  .handler(async ({ data, context }) => {
    const { performManualCouncilReview } = await import("./manualCouncil.server");
    return performManualCouncilReview(data, context);
  });
