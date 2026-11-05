import { z } from "zod";
import { INTERNAL_LIVE_SYMBOLS } from "./liveOrder.js";

const TpTierSchema = z
  .object({
    size_frac: z.number().finite().positive().max(1),
    rr_multiple: z.number().finite().positive().max(100),
  })
  .strict();

export const AutomationOrderSchema = z
  .object({
    user_id: z.string().uuid(),
    connection_id: z.string().uuid(),
    venue: z.enum(["apex_omni", "aster", "synfutures"]),
    symbol: z.enum([...INTERNAL_LIVE_SYMBOLS, "BTC-USDC", "ETH-USDC"]),
    side: z.enum(["BUY", "SELL"]),
    order_type: z.enum(["MARKET", "LIMIT"]),
    size: z.number().finite().positive().optional(),
    price: z.number().finite().positive().nullable().optional(),
    leverage: z.number().int().min(1).max(125).optional(),
    margin_usdc: z.string().regex(/^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/).optional(),
    reduce_only: z.boolean().optional(),
    purpose: z.string().min(1).max(64),
    idempotency_key: z.string().min(8).max(64),
    stop_pct: z.number().finite().positive().max(0.25).optional(),
    tp_tiers: z.array(TpTierSchema).max(5).optional(),
    campaign_rung_count: z.number().int().min(1).max(5).optional(),
    campaign_margin_usd: z.number().finite().nonnegative().nullable().optional(),
    campaign_margin_per_rung_usd: z.number().finite().nonnegative().nullable().optional(),
    is_live: z.literal(true),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.venue === "synfutures") {
      if (!["BTC-USDC", "ETH-USDC"].includes(input.symbol) || input.leverage === undefined || input.leverage > 33
        || input.margin_usdc === undefined || /^0(?:\.0+)?$/.test(input.margin_usdc)
        || input.reduce_only === true || input.order_type !== "MARKET" || input.size !== undefined
        || input.price != null || input.campaign_rung_count !== undefined || input.stop_pct !== undefined
        || input.tp_tiers !== undefined || input.campaign_margin_usd !== undefined || input.campaign_margin_per_rung_usd !== undefined) {
        ctx.addIssue({code:z.ZodIssueCode.custom,message:"SynFutures requires native exact entry inputs"});
      }
    } else if (input.margin_usdc !== undefined || !INTERNAL_LIVE_SYMBOLS.includes(input.symbol as typeof INTERNAL_LIVE_SYMBOLS[number])) {
      ctx.addIssue({code:z.ZodIssueCode.custom,message:"Venue symbol or amount mismatch"});
    }
    if (input.venue === "apex_omni" && input.leverage !== undefined && input.leverage > 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["leverage"], message: "ApeX leverage must not exceed 100" });
    }
  });

export type AutomationOrderInput = z.infer<typeof AutomationOrderSchema>;

// Every automated entry follows the owner's five-rung contract. The signer
// now rebuilds all five LIMIT rungs from authenticated venue equity and
// contract limits; the worker's dollar fields are audit hints only.
// Reduce-only exits remain single orders.
export function unsupportedCampaignReason(input: AutomationOrderInput): string | null {
  // Native SynFutures requests reach its private account preflight. That
  // adapter refuses entries until campaign parity and exit coverage exist.
  if (input.venue === "synfutures") return null;
  if (input.venue === "aster") {
    if (input.reduce_only === true) {
      return input.order_type === "MARKET" && input.size !== undefined
        && input.campaign_rung_count === undefined && input.leverage === undefined
        && input.price == null && input.stop_pct === undefined && input.tp_tiers === undefined
        ? null : "ASTER_REDUCE_ONLY_EXIT_REQUIRED";
    }
    if (
      input.order_type !== "MARKET" ||
      input.campaign_rung_count !== 5 ||
      input.leverage === undefined ||
      input.size !== undefined ||
      input.price != null ||
      input.stop_pct !== undefined ||
      input.tp_tiers !== undefined
    ) return "ASTER_FIVE_RUNG_ENTRY_REQUIRED";
    return null;
  }
  if (input.reduce_only === true) return null;
  if (
    input.purpose === "proof_of_life" &&
    input.side === "BUY" &&
    input.order_type === "MARKET" &&
    input.size === 0.001 &&
    input.campaign_rung_count === undefined
  ) return null;
  if (input.campaign_rung_count === 5) return null;
  return "FIVE_RUNG_CAMPAIGN_REQUIRED";
}

// The worker's purpose is audit data, not authority to opt out of protections.
// A replay-protected automation caller must never select the signer's
// proof-of-life or manual live-test exemptions.
export function automationSignerPurpose(input: AutomationOrderInput): string {
  if (input.venue === "aster") return input.reduce_only === true ? "CLOSE_POSITION" : "AUTOMATED_ENTRY";
  return input.reduce_only === true ? "CLOSE_POSITION" : "AUTOMATED_ENTRY";
}
