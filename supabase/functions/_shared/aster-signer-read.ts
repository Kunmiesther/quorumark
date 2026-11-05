// Read-only Aster transport. No trading flag, credentials or order endpoint.
// Structural DTOs intentionally avoid importing the Deno-only ApeX credential reader.
type NormalizedPosition = {
  symbol: string; side: "LONG" | "SHORT"; size: number;
  entryPrice: number; markPrice: number; liquidationPrice: number;
  leverage: number; unrealizedPnl: number;
};
type RawOpenOrder = { id: string; symbol: string; reduceOnly: boolean; [key: string]: unknown };
type NormalizedFill = {
  venue_fill_id: string; venue_order_id: string; symbol: string; side: "BUY" | "SELL";
  price: string; size: string; fee: string; fee_currency: string; liquidity: string;
  fill_ts_ms: number;
};

type Options = { baseUrl?: string; secret?: string; timeoutMs?: number; fetchImpl?: typeof fetch };
type Connection = { id: string; user_id: string; exchange: string; environment: string | null };

// Only stable adapter codes, never an upstream body/message/URL/credential.
const SAFE_READ_CODES = new Set([
  "ASTER_SNAPSHOT_INVALID_NUMBER", "ASTER_SNAPSHOT_INVALID_SYMBOL", "ASTER_SNAPSHOT_INVALID_BOOLEAN",
  "ASTER_POSITION_IDENTITY_UNCONFIRMED", "ASTER_OPEN_ORDER_IDENTITY_UNCONFIRMED",
  "ASTER_OPEN_ORDER_QUANTITY_UNCONFIRMED", "ASTER_INVALID_POSITIONS_RESPONSE",
  "ASTER_INVALID_OPEN_ORDERS_RESPONSE", "ASTER_INVALID_ACCOUNT_RESPONSE", "ASTER_INVALID_FILLS_RESPONSE",
  "ASTER_FILL_WINDOW_INCOMPLETE", "ASTER_FILL_WINDOW_INVALID", "ASTER_FILL_WINDOW_MISMATCH",
  "ASTER_FILL_IDENTITY_UNCONFIRMED", "ASTER_FILL_DUPLICATE", "ASTER_AUTH_OR_REGION_REJECTED",
  "ASTER_RATE_LIMITED", "ASTER_UNAVAILABLE", "ASTER_REQUEST_REJECTED", "ASTER_TIMEOUT",
  "ASTER_NETWORK_ERROR", "ASTER_INVALID_RESPONSE", "ASTER_MAIN_WALLET_DEPOSIT_REQUIRED",
]);
export class AsterReadError extends Error {}
export function asterReadFailure(error: unknown, fallback: string): string {
  return error instanceof AsterReadError ? error.message : fallback;
}

export async function readAster(
  conn: Connection, action: "equity" | "positions" | "fills" | "reconcile-orders",
  payload: { since_ts_ms?: number | null } = {}, opts: Options = {},
): Promise<Record<string, unknown>> {
  if (conn.exchange !== "aster" || !["mainnet", "production"].includes(conn.environment ?? "")) throw new Error("ASTER_CONNECTION_MISMATCH");
  const env = (globalThis as unknown as { Deno?: { env: { get: (k: string) => string | undefined } } }).Deno?.env;
  const base = (opts.baseUrl ?? env?.get("SIGNER_BASE_URL") ?? "").replace(/\/$/, "");
  const secret = opts.secret ?? env?.get("SIGNER_SHARED_SECRET");
  if (!base || !secret) throw new Error("ASTER_READER_NOT_CONFIGURED");
  const path = `/v1/aster/${action}`;
  const body = JSON.stringify({ ...payload, user_id: conn.user_id, exchange_connection_id: conn.id });
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`${ts}\n${nonce}\n${path}\n${body}`));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${base}${path}`, {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", "x-signer-timestamp": ts,
        "x-signer-nonce": nonce, "x-signer-signature": hex }, body,
    });
    if (!res.ok) {
      const failure = await res.json().catch(() => null);
      const code = failure?.detail;
      const safe = typeof code === "string" && (SAFE_READ_CODES.has(code) || /^ASTER_\d{3,6}$/.test(code));
      throw new AsterReadError(safe ? code : `ASTER_READ_HTTP_${res.status}`);
    }
    const data = await res.json();
    if (data?.status !== "ok" || data.exchange !== "aster" || data.environment !== "mainnet" || data.connection_id !== conn.id) {
      throw new Error("ASTER_READ_IDENTITY_UNCONFIRMED");
    }
    return data;
  } finally { clearTimeout(timer); }
}

function finite(value: unknown): number {
  if ((typeof value !== "string" && typeof value !== "number") || value === "" || !Number.isFinite(Number(value))) {
    throw new Error("ASTER_SNAPSHOT_INVALID_NUMBER");
  }
  return Number(value);
}

export function asterPositions(data: Record<string, unknown>): { positions: NormalizedPosition[]; orders: RawOpenOrder[] } {
  if (!Array.isArray(data.positions) || !Array.isArray(data.open_orders)) throw new Error("ASTER_SNAPSHOT_INCOMPLETE");
  const positions = data.positions.map(p => {
    if (!p || typeof p.symbol !== "string" || !["LONG", "SHORT"].includes(p.side) || finite(p.size) <= 0) {
      throw new Error("ASTER_POSITION_INVALID");
    }
    return { symbol: p.symbol, side: p.side as "LONG" | "SHORT", size: finite(p.size),
      entryPrice: finite(p.entry_price), markPrice: finite(p.mark_price),
      liquidationPrice: finite(p.liquidation_price), leverage: finite(p.leverage), unrealizedPnl: finite(p.unrealized_pnl) };
  });
  const orders = data.open_orders.map(o => {
    if (!o || typeof o.symbol !== "string" || typeof o.id !== "string" || typeof o.reduceOnly !== "boolean") {
      throw new Error("ASTER_OPEN_ORDER_INVALID");
    }
    return o as RawOpenOrder;
  });
  return { positions, orders };
}

export function asterEquity(data: Record<string, unknown>) {
  const available = finite(data.available_balance);
  if (available < 0 || data.currency !== "USDT") throw new Error("ASTER_EQUITY_INVALID");
  return { total_equity: finite(data.total_equity), available_balance: available, currency: "USDT" };
}

export function asterFills(data: Record<string, unknown>): { fills: NormalizedFill[]; completeThrough: number } {
  if (!Array.isArray(data.fills) || !Number.isSafeInteger(data.complete_through_ms) || Number(data.complete_through_ms) < 0) {
    throw new Error("ASTER_FILL_WINDOW_INCOMPLETE");
  }
  const fills = data.fills.map(f => {
    if (!f || typeof f.venue_fill_id !== "string" || typeof f.venue_order_id !== "string"
      || typeof f.symbol !== "string" || !["BUY", "SELL"].includes(f.side)
      || finite(f.price) <= 0 || finite(f.size) <= 0 || f.fee_currency !== "USDT"
      || !Number.isSafeInteger(f.fill_ts_ms) || f.fill_ts_ms > Number(data.complete_through_ms)) {
      throw new Error("ASTER_FILL_INVALID");
    }
    finite(f.fee);
    return f as NormalizedFill;
  });
  return { fills, completeThrough: Number(data.complete_through_ms) };
}
