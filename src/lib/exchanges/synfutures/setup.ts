import { z } from "zod";

export const synFuturesSetupInput = z
  .object({
    walletId: z.string().uuid(),
    allocationUsdc: z
      .string()
      .trim()
      .regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/, "Enter a USDC amount with up to 6 decimals.")
      .refine((value) => Number(value) > 0, "Allocation must be positive.")
      .refine((value) => {
        const [whole, fraction = ""] = value.split(".");
        return Number(value).toFixed(6) === `${whole}.${fraction.padEnd(6, "0")}`;
      }, "Amount exceeds exact supported precision."),
    maxLeverage: z.number().int().min(1).max(65535),
    expectedRevision: z.number().int().min(0).max(2147483646),
  })
  .strict();

export type SynFuturesSetupDraft = {
  id: string;
  wallet_id: string;
  allocation_usdc: number;
  max_leverage: number;
  chain_id: number;
  status: "draft";
  revision: number;
  updated_at: string;
};

/** A configuration ceiling, not evidence of supported leverage or trade permission. */
export function setupMatchesInput(draft: SynFuturesSetupDraft, amount: string, leverage: string) {
  return (
    Number(amount) === Number(draft.allocation_usdc) && Number(leverage) === draft.max_leverage
  );
}
