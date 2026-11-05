import { z } from "zod";

/** The currently implemented simulator contract: no silently ignored ticket fields. */
export const paperDeskTicket = z.object({
  requestId: z.string().uuid(),
  symbol: z.enum(["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT"]),
  side: z.enum(["long", "short"]),
  kind: z.literal("market", { errorMap: () => ({ message: "Resting paper limit orders are not implemented. Choose Market." }) }),
  marginUsd: z.number().finite().positive(),
  leverage: z.number().finite().int().min(1),
  limitPrice: z.null(),
  takeProfit: z.number().finite().positive().nullable(),
  stopLoss: z.number().finite().positive().nullable(),
  dcaEnabled: z.literal(false, { errorMap: () => ({ message: "Manual paper DCA is not implemented. Use a single entry." }) }),
  rungCount: z.literal(1),
  spacingPct: z.literal(0),
});
export type PaperDeskTicket = z.infer<typeof paperDeskTicket>;

export function validatePaperProtection(ticket: PaperDeskTicket, entry: number) {
  if (ticket.takeProfit != null && (ticket.side === "long" ? ticket.takeProfit <= entry : ticket.takeProfit >= entry))
    throw new Error("Take profit is on the wrong side of the current entry price.");
  if (ticket.stopLoss != null && (ticket.side === "long" ? ticket.stopLoss >= entry : ticket.stopLoss <= entry))
    throw new Error("Stop loss is on the wrong side of the current entry price.");
}
