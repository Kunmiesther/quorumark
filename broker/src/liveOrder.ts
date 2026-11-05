import { z } from "zod";

export const INTERNAL_LIVE_SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT"] as const;

export const BROKER_CANARY_MAX_NOTIONAL_USD = 100;
export const BROKER_CANARY_MAX_LEVERAGE = 5;

export const LiveOrderSchema = z
  .object({
    connection_id: z.string().uuid(),
    client_order_id: z.string().min(8).max(64),
    symbol: z.enum(INTERNAL_LIVE_SYMBOLS),
    side: z.enum(["BUY", "SELL"]),
    order_type: z.literal("MARKET"),
    size: z.number().finite().positive(),
    leverage: z.number().int().min(1).max(BROKER_CANARY_MAX_LEVERAGE),
    est_notional_usd: z.number().finite().positive().max(BROKER_CANARY_MAX_NOTIONAL_USD),
    reduce_only: z.literal(false),
    environment: z.literal("mainnet"),
    purpose: z.literal("internal_owner_canary"),
  })
  .strict();

export type LiveOrderInput = z.infer<typeof LiveOrderSchema>;

export interface LiveOrderLimits {
  maxLeverage: number;
  maxOrderSizeUsd: number;
  maxTotalExposureUsd: number;
  dailyLossLimitUsd: number;
}

/**
 * Public-broker risk boundary. The private signer and venue repeat their own
 * authoritative checks; this layer prevents an obviously oversized request
 * from reaching either one.
 */
export function liveOrderRiskRejection(
  input: Pick<LiveOrderInput, "est_notional_usd" | "leverage">,
  currentExposureUsd: number,
  todayRealisedUsd: number,
  limits: LiveOrderLimits,
): string | null {
  const maxLeverage = Math.min(BROKER_CANARY_MAX_LEVERAGE, limits.maxLeverage);
  const maxOrder = Math.min(BROKER_CANARY_MAX_NOTIONAL_USD, limits.maxOrderSizeUsd);
  if (input.leverage > maxLeverage) return `LEVERAGE_ABOVE_LIMIT_${maxLeverage}`;
  if (input.est_notional_usd > maxOrder) return `ORDER_ABOVE_LIMIT_${maxOrder}`;
  if (currentExposureUsd + input.est_notional_usd > limits.maxTotalExposureUsd) {
    return `TOTAL_EXPOSURE_ABOVE_LIMIT_${limits.maxTotalExposureUsd}`;
  }
  if (Math.max(0, -todayRealisedUsd) >= limits.dailyLossLimitUsd) {
    return `DAILY_LOSS_LIMIT_REACHED_${limits.dailyLossLimitUsd}`;
  }
  return null;
}
