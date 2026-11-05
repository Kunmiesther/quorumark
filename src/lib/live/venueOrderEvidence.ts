/** Read-only comparison between a stored TP claim and reconciled venue orders. */
export function tpOrderEvidence(
  state: string,
  storedOrderId: string | null,
  orders: unknown,
): "not_applicable" | "visible" | "unverified" {
  if (state !== "TP_SET" && state !== "PARTIAL_TP_SET") return "not_applicable";
  if (!storedOrderId || !Array.isArray(orders)) return "unverified";
  const visible = orders.some((order) => {
    if (!order || typeof order !== "object") return false;
    const row = order as Record<string, unknown>;
    return [row.id, row.orderId, row.order_id].some(
      (id) => id != null && String(id) === storedOrderId,
    );
  });
  return visible ? "visible" : "unverified";
}
