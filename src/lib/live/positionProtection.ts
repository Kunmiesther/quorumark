export type ProtectionLevel = {
  id: string;
  price: number;
  quantity: number | null;
  closePosition: boolean;
};
export type PositionProtection = { takeProfits: ProtectionLevel[]; stops: ProtectionLevel[] };
const truth = (value: unknown) =>
  value === true || value === "true" || value === 1 || value === "1";
const symbolKey = (value: unknown) =>
  String(value ?? "")
    .replace(/[-_/]/g, "")
    .toUpperCase();
const positive = (...values: unknown[]) => {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
};

/** Read-only venue evidence. Bot targets and review state are not resting orders. */
export function readPositionProtection(
  orders: unknown,
  symbol: string,
  side: string,
  storedTpOrderId?: string | null,
): PositionProtection {
  const result: PositionProtection = { takeProfits: [], stops: [] };
  if (!Array.isArray(orders) || !["long", "short"].includes(side.toLowerCase())) return result;
  const closingSide = side.toLowerCase() === "long" ? "SELL" : "BUY";
  const seen = new Set<string>();
  for (const value of orders) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    if (
      symbolKey(row.symbol) !== symbolKey(symbol) ||
      String(row.side).toUpperCase() !== closingSide
    )
      continue;
    const positionSide = String(row.positionSide ?? row.position_side ?? "BOTH").toUpperCase();
    if (positionSide !== "BOTH" && positionSide !== side.toUpperCase()) continue;
    const status = String(row.status ?? "").toUpperCase();
    if (status && !["NEW", "OPEN", "PENDING", "UNTRIGGERED", "PARTIALLY_FILLED"].includes(status))
      continue;
    const closePosition = truth(row.closePosition ?? row.close_position);
    if (!truth(row.reduceOnly ?? row.reduce_only) && !closePosition) continue;
    const type = String(row.type ?? row.orderType ?? row.order_type ?? "").toUpperCase();
    const id = String(row.id ?? row.orderId ?? row.order_id ?? "");
    const isTp =
      type.includes("TAKE_PROFIT") ||
      type.includes("TAKEPROFIT") ||
      (type === "LIMIT" && !!storedTpOrderId && id === storedTpOrderId);
    // A trailing-stop activation price is not a fixed protective stop level.
    const isStop = !isTp && type.includes("STOP") && !type.includes("TRAILING");
    if (!isTp && !isStop) continue;
    // Market orders commonly report price=0: use a positive trigger first.
    const price = positive(
      row.trigger_price,
      row.triggerPrice,
      row.stop_price,
      row.stopPrice,
      ...(type === "LIMIT" ? [row.price] : []),
    );
    if (price === null) continue;
    const quantity = positive(row.size, row.quantity, row.qty, row.origQty);
    const key = id || `${type}:${price}:${quantity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (isTp ? result.takeProfits : result.stops).push({ id: key, price, quantity, closePosition });
  }
  const direction = side.toLowerCase() === "long" ? 1 : -1;
  result.takeProfits.sort((a, b) => direction * (a.price - b.price));
  result.stops.sort((a, b) => direction * (b.price - a.price));
  return result;
}
