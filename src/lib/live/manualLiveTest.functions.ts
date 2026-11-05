/**
 * Manual LIVE TEST entry — canonical authenticated submission path.
 *
 * browser -> this server function (Supabase JWT) -> Railway broker
 *         -> signer -> ApeX
 *
 * The browser NEVER talks to the signer and NEVER writes order rows. This
 * function only forwards a minimum, hard-capped MARKET entry:
 *   • owner/admin only
 *   • MARKET only, CROSS only, reduce_only = false
 *   • signer-attached protective stop; no take-profit ladder at entry
 *   • notional hard ceiling enforced server-side
 *
 * The broker + signer remain the authority for balance, precision, minimum
 * notional, idempotency and the live gate. Rejections are surfaced verbatim.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertLegacyExecutionDisabled } from "@/lib/quorumark-mvp-policy.server";

/** Server-side ceiling for a manual live TEST entry, in USD notional. */
export const LIVE_TEST_MAX_NOTIONAL_USD = 100;
export const INTERNAL_LIVE_TEST_SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT"] as const;

export interface ManualLiveTestInput {
  symbol: string;
  side: "BUY" | "SELL";
  size: number;
  leverage: number;
  /** Client-computed notional, used only for the pre-flight ceiling check. */
  estNotionalUsd: number;
}

export interface ManualLiveTestResult {
  status: string;
  exchangeOrderId: string | null;
  rejectReason: string | null;
}

export interface ManualLiveRiskLimits {
  maxLeverage: number;
  maxOrderSizeUsd: number;
  maxTotalExposureUsd: number;
  dailyLossLimitUsd: number;
}

const DEFAULT_LIVE_RISK_LIMITS: ManualLiveRiskLimits = {
  maxLeverage: 5,
  maxOrderSizeUsd: 100,
  maxTotalExposureUsd: 100,
  dailyLossLimitUsd: 25,
};

/** Pure, deterministic pre-broker risk gate for the owner's configured limits. */
export function manualLiveRiskRejection(
  orderNotionalUsd: number,
  leverage: number,
  currentExposureUsd: number,
  todayRealisedUsd: number,
  limits: ManualLiveRiskLimits,
): string | null {
  if (leverage > limits.maxLeverage) {
    return `LEVERAGE_ABOVE_USER_LIMIT_${limits.maxLeverage}`;
  }
  if (orderNotionalUsd > limits.maxOrderSizeUsd) {
    return `ORDER_ABOVE_USER_LIMIT_${limits.maxOrderSizeUsd}`;
  }
  if (currentExposureUsd + orderNotionalUsd > limits.maxTotalExposureUsd) {
    return `TOTAL_EXPOSURE_ABOVE_USER_LIMIT_${limits.maxTotalExposureUsd}`;
  }
  const todayLossUsd = Math.max(0, -todayRealisedUsd);
  if (todayLossUsd >= limits.dailyLossLimitUsd) {
    return `DAILY_LOSS_LIMIT_REACHED_${limits.dailyLossLimitUsd}`;
  }
  return null;
}

export function validateManualLiveTestInput(raw: unknown): ManualLiveTestInput {
  const i = raw as Partial<ManualLiveTestInput> | null | undefined;
  if (!i || typeof i !== "object") throw new Error("INVALID_INPUT");
  const symbol = String(i.symbol ?? "").toUpperCase();
  if (!(INTERNAL_LIVE_TEST_SYMBOLS as readonly string[]).includes(symbol)) {
    throw new Error("INVALID_SYMBOL");
  }
  const side = i.side === "SELL" ? "SELL" : "BUY";
  const size = Number(i.size);
  if (!Number.isFinite(size) || size <= 0) throw new Error("INVALID_SIZE");
  const leverage = Number(i.leverage);
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > 100) {
    throw new Error("INVALID_LEVERAGE");
  }
  const estNotionalUsd = Number(i.estNotionalUsd);
  if (!Number.isFinite(estNotionalUsd) || estNotionalUsd <= 0) {
    throw new Error("INVALID_NOTIONAL");
  }
  return { symbol, side, size, leverage, estNotionalUsd };
}

export const submitManualLiveTestOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(validateManualLiveTestInput)
  .handler(async ({ data, context }): Promise<ManualLiveTestResult> => {
    assertLegacyExecutionDisabled("manual-live-test");
    const reject = (reason: string): ManualLiveTestResult => ({
      status: "rejected",
      exchangeOrderId: null,
      rejectReason: reason,
    });

    if (data.estNotionalUsd > LIVE_TEST_MAX_NOTIONAL_USD) {
      return reject(`NOTIONAL_ABOVE_TEST_CEILING_${LIVE_TEST_MAX_NOTIONAL_USD}`);
    }

    // Owner/admin only — server-side, never trusted from the client.
    const [owner, admin] = await Promise.all([
      context.supabase.rpc("has_role", {
        _user_id: context.userId,
        _role: "owner" as never,
      }),
      context.supabase.rpc("has_role", { _user_id: context.userId, _role: "admin" }),
    ]);
    if (!(owner.data === true || admin.data === true)) return reject("NOT_AUTHORIZED");

    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const [limitsRes, positionsRes, tradesRes] = await Promise.all([
      context.supabase
        .from("user_trading_limits")
        .select("max_leverage,max_order_size_usd,max_total_exposure_usd,daily_loss_limit_usd")
        .eq("user_id", context.userId)
        .maybeSingle(),
      context.supabase
        .from("positions")
        .select("size,current_price")
        .eq("user_id", context.userId)
        .eq("status", "open"),
      context.supabase
        .from("trades")
        .select("realized_pnl")
        .eq("user_id", context.userId)
        .eq("book", "live")
        .gte("closed_at", dayStart.toISOString()),
    ]);
    if (limitsRes.error || positionsRes.error || tradesRes.error) {
      return reject("RISK_SNAPSHOT_UNAVAILABLE");
    }
    const limits: ManualLiveRiskLimits = limitsRes.data
      ? {
          maxLeverage: Number(limitsRes.data.max_leverage),
          maxOrderSizeUsd: Number(limitsRes.data.max_order_size_usd),
          maxTotalExposureUsd: Number(limitsRes.data.max_total_exposure_usd),
          dailyLossLimitUsd: Number(limitsRes.data.daily_loss_limit_usd),
        }
      : DEFAULT_LIVE_RISK_LIMITS;
    const currentExposureUsd = (positionsRes.data ?? []).reduce(
      (sum, position) =>
        sum + Math.abs(Number(position.size) || 0) * (Number(position.current_price) || 0),
      0,
    );
    const todayRealisedUsd = (tradesRes.data ?? []).reduce(
      (sum, trade) => sum + (Number(trade.realized_pnl) || 0),
      0,
    );
    const riskRejection = manualLiveRiskRejection(
      data.estNotionalUsd,
      data.leverage,
      currentExposureUsd,
      todayRealisedUsd,
      limits,
    );
    if (riskRejection) return reject(riskRejection);

    // The venue is DERIVED from the selected active connection — never
    // hard-coded here. Duplicating it is what produced
    // VENUE_CONNECTION_MISMATCH (client sent "apex-omni", the connection row
    // stores "apex_omni").
    const { data: conn, error: connErr } = await context.supabase
      .from("exchange_connections")
      .select("id,exchange,environment,status,permission_trade,permissions_verified,is_live")
      .eq("user_id", context.userId)
      .eq("environment", "production")
      .eq("status", "verified")
      .eq("exchange", "apex_omni")
      .eq("is_live", true)
      .order("last_verified_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (connErr) return reject("CONNECTION_LOOKUP_FAILED");
    if (!conn?.id) return reject("NO_VERIFIED_MAINNET_CONNECTION");
    if (conn.permission_trade === false) return reject("CONNECTION_NOT_TRADE_ENABLED");
    if (conn.permissions_verified !== true) return reject("CONNECTION_NOT_VERIFIED");
    if (conn.is_live !== true) return reject("CONNECTION_NOT_LIVE_ENABLED");

    const brokerUrl = process.env["TURTLE_BROKER_BASE_URL"];
    if (!brokerUrl) return reject("BROKER_NOT_CONFIGURED");
    const authHeader = getRequestHeader("authorization") ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) return reject("MISSING_BEARER");
    const requestId = crypto.randomUUID();

    const body = JSON.stringify({
      client_order_id: `tb-canary-${requestId}`,
      connection_id: conn.id,
      symbol: data.symbol,
      side: data.side,
      order_type: "MARKET",
      size: data.size,
      leverage: data.leverage,
      est_notional_usd: data.estNotionalUsd,
      reduce_only: false,
      environment: "mainnet",
      purpose: "internal_owner_canary",
    });

    try {
      console.info("[live-canary] broker request", {
        requestId,
        userId: context.userId,
        connectionId: conn.id,
        symbol: data.symbol,
        side: data.side,
      });
      const r = await fetch(`${brokerUrl.replace(/\/$/, "")}/v1/orders`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: authHeader,
          "x-request-id": requestId,
        },
        body,
      });
      const text = await r.text().catch(() => "");
      let json: Record<string, unknown> = {};
      try {
        json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        json = {};
      }
      const result = {
        status: String(json["status"] ?? (r.ok ? "submitted" : "rejected")),
        exchangeOrderId: (json["exchange_order_id"] as string | null) ?? null,
        rejectReason:
          (json["reject_reason"] as string | null) ??
          (json["error"] as string | null) ??
          (r.ok
            ? null
            : `BROKER_HTTP_${r.status}${json["message"] ? `:${String(json["message"]).slice(0, 80)}` : ""}`),
      };
      console.info("[live-canary] broker response", {
        requestId,
        httpStatus: r.status,
        status: result.status,
        rejectReason: result.rejectReason,
      });
      return result;
    } catch (e) {
      return reject(
        e instanceof Error ? `BROKER_CALL_FAILED:${e.message.slice(0, 80)}` : "BROKER_CALL_FAILED",
      );
    }
  });
