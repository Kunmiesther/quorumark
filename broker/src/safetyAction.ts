import { z } from "zod";

export const SafetyActionSchema = z
  .object({
    connection_id: z.string().uuid(),
  })
  .strict();

export type SafetyActionInput = z.infer<typeof SafetyActionSchema>;

export interface VenuePositionSnapshot {
  symbol?: unknown;
  side?: unknown;
  size?: unknown;
  leverage?: unknown;
}

export interface VenueOrderSnapshot {
  client_order_id?: unknown;
}

export interface ReduceOnlyCloseIntent {
  symbol: string;
  side: "BUY" | "SELL";
  size: number;
  leverage: number;
}

const SUPPORTED_SYMBOLS = new Set(["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT"]);

/**
 * Convert a signer-owned venue snapshot into a bounded reduce-only exit.
 * Browser input never controls symbol, side, size, or leverage.
 */
export function reduceOnlyCloseIntents(
  positions: VenuePositionSnapshot[],
): ReduceOnlyCloseIntent[] {
  const intents: ReduceOnlyCloseIntent[] = [];
  for (const position of positions) {
    const symbol = String(position.symbol ?? "")
      .trim()
      .toUpperCase();
    if (!SUPPORTED_SYMBOLS.has(symbol)) continue;
    const side = String(position.side ?? "")
      .trim()
      .toUpperCase();
    if (!(side === "LONG" || side === "BUY" || side === "SHORT" || side === "SELL")) {
      continue;
    }
    const size = Number(position.size);
    if (!Number.isFinite(size) || size <= 0) continue;
    const rawLeverage = Number(position.leverage);
    const leverage = Number.isFinite(rawLeverage)
      ? Math.max(1, Math.min(100, Math.trunc(rawLeverage)))
      : 1;
    intents.push({
      symbol,
      side: side === "LONG" || side === "BUY" ? "SELL" : "BUY",
      size,
      leverage,
    });
  }
  return intents;
}

/** Return only IDs the signer can cancel; missing venue client IDs are reported separately. */
export function cancellableClientOrderIds(orders: VenueOrderSnapshot[]): string[] {
  return Array.from(
    new Set(
      orders
        .map((order) => String(order.client_order_id ?? "").trim())
        .filter((value) => value.length >= 1 && value.length <= 128),
    ),
  );
}
