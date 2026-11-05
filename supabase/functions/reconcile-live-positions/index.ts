// reconcile-live-positions — polls ApeX Omni /api/v3/account for every
// live ApeX connection and upserts into public.positions with source='live'.
//
// OWNER RULING #12: this reader authenticates and signs its own GET
// requests against ApeX Omni IN-PROCESS. It does NOT call the signer
// container. The signer stays exclusively for order placement /
// modification / cancellation, so a signer outage can no longer blind the
// owner to his own positions.
//
// SAFETY
//   * READ-ONLY at the venue: only GET /api/v3/account + GET /api/v3/open-orders.
//   * Never touches paper rows: every read/write filters source='live'.
//   * Never logs credentials, ciphertext, or raw venue payloads.
//   * Idempotent per (user, connection, symbol, side) via the
//     `positions_live_open_unique` partial index.
//
// AUTH
//   Verified users observe only their own accounts. An exact configured
//   service credential is required to run the scheduled cross-account sweep.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  fetchOpenOrders,
  fetchApexOrder,
  fetchApexHistoricalPnl,
  fetchAccountEquity,
  fetchOpenPositions,
  loadApexReadCreds,
  type NormalizedPosition,
  type RawOpenOrder,
} from "../_shared/apex-omni-read.ts";
import { classifyOrigin, requireOriginReads } from "../_shared/position-origin.ts";
import { readAster, asterPositions, asterReadFailure } from "../_shared/aster-signer-read.ts";
import { livePositionClosePatch, reconcileConnections } from "../_shared/live-position-close.ts";
import { reconcileClosedPositionPnl, reconcileApexReportedPnl } from "../_shared/closed-position-pnl.ts";
import { recoverApexOrders } from "../_shared/apex-order-recovery.ts";
import { observeApexClosedPnl } from "../_shared/apex-pnl-observation.ts";
import { isAuthorizedServiceReader } from "../_shared/service-reader-auth.ts";
import { selectReadableVenueConnections } from "../_shared/venue-read-policy.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

interface ConnRow {
  id: string;
  user_id: string;
  exchange: string;
  environment: string | null;
  market_type: string | null;
  is_live: boolean;
  status: string | null;
}

type SB = SupabaseClient;

const RECON_VERSION = "recon-4-scoped-concurrent-accounting";


// Observe spendable collateral independently of position/order bookkeeping.
// A balance read failure never replaces verified exposure with an empty list.
async function observeAccountEquity(supabase: SB, conn: ConnRow, timeoutMs: number) {
  try {
    if (conn.exchange === "aster") {
      const value = await readAster(conn, "equity", {}, { timeoutMs });
      return { ok: true, currency: value.currency, total_equity: value.total_equity,
        available_balance: value.available_balance };
    }
    const loaded = await loadApexReadCreds(supabase, conn.id, conn.environment ?? "mainnet");
    if (!loaded.ok) return { ok: false };
    const result = await fetchAccountEquity(loaded.creds, timeoutMs);
    return result.ok ? { ok: true, ...result.equity } : { ok: false };
  } catch { return { ok: false }; }
}

async function reconcileOne(supabase: SB, conn: ConnRow, timeoutMs: number) {
  let positions: NormalizedPosition[];
  let orders: RawOpenOrder[];
  let orderReconciliationRequired = false;
  let orderRecovery: Record<string, unknown> | null = null;
  let pnlHistory: Record<string, unknown> | null = null;
  if (conn.exchange === "aster") {
    try {
      ({ positions, orders } = asterPositions(await readAster(conn, "positions", {}, { timeoutMs })));
    } catch (error) {
      return { connection_id: conn.id, ok: false, reason: asterReadFailure(error, "ASTER_POSITION_READ_FAILED") };
    }
    // An uncertain historic order must remain visible without hiding fresh
    // account exposure. Ledger reconciliation can never place/cancel an order.
    try {
      const ledger = await readAster(conn, "reconcile-orders", {}, { timeoutMs });
      orderReconciliationRequired = ledger.reconciliation_required !== false;
    } catch { orderReconciliationRequired = true; }
  } else {
  const credLoad = await loadApexReadCreds(supabase, conn.id, conn.environment ?? "mainnet");
  if (!credLoad.ok) return { connection_id: conn.id, ok: false, reason: credLoad.reason };
  const creds = credLoad.creds;

  const [posResp, ordResp] = await Promise.all([
    fetchOpenPositions(creds, timeoutMs),
    fetchOpenOrders(creds, timeoutMs),
  ]);
  if (!posResp.ok) return { connection_id: conn.id, ok: false, reason: posResp.reason };
  // Position and open-order reads form one protection snapshot. If the order
  // read fails, do not overwrite the last known orders with an empty array or
  // claim a fresh reconciliation that could authorize a Council exit/TP.
  if (!ordResp.ok) return { connection_id: conn.id, ok: false, reason: ordResp.reason };
  positions = posResp.positions;
  orders = ordResp.orders;
  [orderRecovery,pnlHistory] = await Promise.all([
    recoverApexOrders(supabase, conn, { positions, orders },
      (clientId,context) => fetchApexOrder(creds, clientId, Math.min(timeoutMs, 5000),context)),
    observeApexClosedPnl(supabase,conn,opts=>fetchApexHistoricalPnl(creds,opts,Math.min(timeoutMs,10000))),
  ]);
  }
  const { data: uncertainIntents, error: uncertainError } = await supabase
    .from("order_intents").select("id").eq("user_id", conn.user_id)
    .eq("connection_id", conn.id).eq("state", "reconciliation_required").limit(1);
  orderReconciliationRequired = orderReconciliationRequired || Boolean(uncertainError) || Boolean(uncertainIntents?.length);
  const reconSource = conn.exchange === "aster" ? "aster_futures_v3" : "apex_omni_rest_v3";

  const now = new Date().toISOString();
  const marketType = conn.market_type || "futures";

  // Resolve the owner-approved execution identity once per connection. A
  // position may be external/manual, so every field remains nullable unless a
  // real live user_strategy row and owned wallet/workflow prove the link.
  const [configsRes, walletsRes, workflowsRes] = await Promise.all([
    supabase
      .from("user_strategy")
      .select("symbol,strategy_id,params")
      .eq("user_id", conn.user_id)
      .eq("connection_id", conn.id)
      .eq("mode", "live"),
    supabase
      .from("wallet_connections")
      .select("id,assigned_exchange_connection_id,is_active,is_default,verified_at,created_at")
      .eq("user_id", conn.user_id)
      .eq("assigned_exchange_connection_id", conn.id)
      .eq("is_active", true)
      .order("is_default", { ascending: false })
      .order("verified_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false }),
    supabase
      .from("autopilot_workflows")
      .select("id")
      .eq("user_id", conn.user_id)
      .eq("connection_id", conn.id),
  ]);
  if (configsRes.error || walletsRes.error || workflowsRes.error) {
    return { connection_id: conn.id, ok: false, reason: "ATTRIBUTION_LOOKUP_FAILED" };
  }
  const configBySymbol = new Map(
    (configsRes.data ?? []).map((config) => [String(config.symbol).toUpperCase(), config]),
  );
  const ownedWalletIds = new Set((walletsRes.data ?? []).map((wallet) => wallet.id));
  const fallbackWalletId = walletsRes.data?.[0]?.id ?? null;
  const ownedWorkflowIds = new Set((workflowsRes.data ?? []).map((workflow) => workflow.id));

  const ordersBySymbol = new Map<string, RawOpenOrder[]>();
  for (const o of orders) {
    const sym = String(o.symbol ?? "").toUpperCase();
    if (!sym) continue;
    const list = ordersBySymbol.get(sym) ?? [];
    list.push(o);
    ordersBySymbol.set(sym, list);
  }

  const seenKeys = new Set<string>();
  const discrepancies: Array<Record<string, unknown>> = [];
  let upserts = 0;
  let inserted = 0;
  for (const p of positions) {
    const sideDb = p.side === "LONG" ? "long" : "short";
    const key = `${p.symbol}::${sideDb}`;
    seenKeys.add(key);
    const attached = ordersBySymbol.get(p.symbol) ?? [];
    const executionConfig = configBySymbol.get(p.symbol.toUpperCase());
    const executionParams =
      executionConfig?.params &&
      typeof executionConfig.params === "object" &&
      !Array.isArray(executionConfig.params)
        ? (executionConfig.params as Record<string, unknown>)
        : {};
    const configuredWalletId = String(executionParams["wallet_connection_id"] ?? "");
    const walletConnectionId = ownedWalletIds.has(configuredWalletId)
      ? configuredWalletId
      : fallbackWalletId;
    const configuredWorkflowId = String(executionParams["autopilot_workflow_id"] ?? "");
    const autopilotWorkflowId = ownedWorkflowIds.has(configuredWorkflowId)
      ? configuredWorkflowId
      : null;

    const entry = p.entryPrice;
    const mark = p.markPrice; // may be null — never fall back to entry
    const size = p.size;
    const uPnl = p.unrealizedPnl; // may be null
    const pnlPct =
      uPnl !== null && entry !== null && entry > 0 && size > 0
        ? (uPnl / (entry * size)) * 100
        : null;

    const row: Record<string, unknown> = {
      user_id: conn.user_id,
      connection_id: conn.id,
      wallet_connection_id: walletConnectionId,
      autopilot_workflow_id: autopilotWorkflowId,
      strategy_id: executionConfig?.strategy_id ?? null,
      exchange: conn.exchange,
      market_type: marketType,
      pair: p.symbol,
      side: sideDb,
      entry_price: entry,
      current_price: mark,
      mark_price: mark,
      size,
      leverage: p.leverage,
      pnl_amount: uPnl,
      pnl_pct: pnlPct,
      unrealized_pnl: uPnl,
      liquidation_price: p.liquidationPrice,
      open_orders: attached,
      status: "open",
      source: "live",
      synced_at: now,
      updated_at: now,
      strategy_metadata: {
        reconciliation: {
          source: reconSource,
          version: RECON_VERSION,
          at: now,
          open_orders_attached: attached.length,
        },
      },
    };

    // ORIGIN CLASSIFICATION. A venue position is only the owner's own manual
    // ApeX trade when NOTHING in Turtle Bot's records accounts for it. The
    // deterministic live path writes `strategy_decisions` (strategy + trace)
    // and `order_audit` (broker submission) — not `orders` — so checking only
    // `orders` mislabelled every bot-opened position as `venue_external` and
    // dropped its originating strategy. Classified once; a previously stored
    // attribution always wins so later cycles cannot re-label the position.
    const { data: priorRow, error: priorError } = await supabase
      .from("positions")
      .select("strategy_metadata")
      .eq("user_id", conn.user_id)
      .eq("connection_id", conn.id)
      .eq("source", "live")
      .eq("status", "open")
      .eq("pair", p.symbol)
      .eq("side", sideDb)
      .maybeSingle();
    if (priorError) {
      return { connection_id: conn.id, ok: false, reason: "POSITION_ORIGIN_READ_FAILED" };
    }
    const priorMeta = (priorRow?.strategy_metadata as Record<string, unknown> | null) ?? null;
    const priorOrigin = priorMeta?.["origin"] ?? null;
    const priorAttribution = priorMeta?.["origin_attribution"] ?? null;

    if (typeof priorOrigin === "string") {
      (row["strategy_metadata"] as Record<string, unknown>)["origin"] = priorOrigin;
      const meta = row["strategy_metadata"] as Record<string, unknown>;
      if (priorAttribution) meta["origin_attribution"] = priorAttribution;
      // Carry the lifecycle spine forward — it is decided once, at import.
      for (const k of ["strategy", "trace_id", "decision_id", "thesis"]) {
        if (priorMeta?.[k]) meta[k] = priorMeta[k];
      }
    } else {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const [decisionsRes, auditsRes, ordersRes] = await Promise.all([
        supabase
          .from("strategy_decisions")
          .select("decision_id, strategy, trace_id, direction, execution_state")
          .eq("connection_id", conn.id)
          .eq("symbol", p.symbol)
          .in("execution_state", ["submitted", "filled", "ambiguous"])
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(5),
        supabase
          .from("order_audit")
          .select("idempotency_key, exchange_order_id, side, phase")
          .eq("connection_id", conn.id)
          .eq("symbol", p.symbol)
          .in("phase", ["submitted", "exchange_response"])
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(5),
        supabase
          .from("orders")
          .select("id")
          .eq("connection_id", conn.id)
          .eq("symbol", p.symbol)
          .in("status", ["filled", "partially_filled", "submitted", "open"])
          .gte("created_at", since)
          .limit(1),
      ]);

      let attribution;
      try {
        attribution = classifyOrigin({
          ...requireOriginReads({ decisions: decisionsRes, audits: auditsRes, orders: ordersRes }),
          side: sideDb,
        });
      } catch {
        // Preserve prior position/management state; do not label a failed
        // ledger read as an owner's manual trade or run the close sweep.
        return { connection_id: conn.id, ok: false, reason: "POSITION_ORIGIN_READ_FAILED" };
      }
      const meta = row["strategy_metadata"] as Record<string, unknown>;
      meta["origin"] = attribution.origin;
      meta["origin_attribution"] = attribution;
      // Lifecycle spine kept at the top level of the metadata so UI bot cards
      // can read "which bot opened this" without knowing the audit shape.
      if (attribution.strategy) meta["strategy"] = attribution.strategy;
      if (attribution.trace_id) meta["trace_id"] = attribution.trace_id;
      if (attribution.decision_id) meta["decision_id"] = attribution.decision_id;
    }
    const attributedDecisionId = (row["strategy_metadata"] as Record<string, unknown>)[
      "decision_id"
    ];
    row["decision_id"] =
      typeof attributedDecisionId === "string" && attributedDecisionId
        ? attributedDecisionId
        : null;

    // Key-based idempotent write. Never keys off a stale id snapshot, so two
    // overlapping cycles can only ever update the same row — they cannot
    // insert a duplicate or close a row another cycle just wrote.
    const { data: updated, error: upErr } = await supabase
      .from("positions")
      .update(row)
      .eq("user_id", conn.user_id)
      .eq("connection_id", conn.id)
      .eq("source", "live")
      .eq("status", "open")
      .eq("pair", p.symbol)
      .eq("side", sideDb)
      .select("id");
    if (upErr)
      return { connection_id: conn.id, ok: false, reason: `DB_UPDATE_FAILED:${upErr.code}` };

    if (!updated || updated.length === 0) {
      row.opened_at = now;

      // MANAGEMENT CLOCK STARTS HERE — and only here. This is the first
      // moment ApeX itself confirms the position exists, i.e. the entry
      // filled. Set on INSERT only: the clock must never be pushed forward
      // by a later reconciliation cycle, or the council's three closed
      // candles would restart every minute.
      row.tp_fill_ts = now;
      row.tp_state = "PENDING_COUNCIL_REVIEW";
      const { error } = await supabase.from("positions").insert(row);

      if (error) {
        // 23505 = the partial unique index caught a concurrent insert; the
        // other cycle already recorded this exact exposure. Not an error.
        if (error.code !== "23505") {
          return { connection_id: conn.id, ok: false, reason: `DB_INSERT_FAILED:${error.code}` };
        }
      } else {
        inserted += 1;
        discrepancies.push({ kind: "missing_locally", pair: p.symbol, side: sideDb, size });
      }
    }
    upserts += 1;
  }

  // Read the local open set AFTER writing, so "not at venue" is decided
  // against current state rather than a snapshot taken before the writes.
  const { data: existingRows, error: exErr } = await supabase
    .from("positions")
    .select("id, pair, side, strategy_metadata")
    .eq("user_id", conn.user_id)
    .eq("connection_id", conn.id)
    .eq("source", "live")
    .eq("status", "open");
  if (exErr) return { connection_id: conn.id, ok: false, reason: `DB_READ_FAILED:${exErr.code}` };

  let closed = 0;
  for (const row of existingRows ?? []) {
    const key = `${row.pair}::${row.side}`;
    if (seenKeys.has(key)) continue;
    const { data: closedRows, error } = await supabase
      .from("positions")
      .update(livePositionClosePatch(now, row.strategy_metadata))
      .eq("id", row.id).eq("user_id", conn.user_id).eq("connection_id", conn.id)
      .eq("source", "live").eq("status", "open").lte("synced_at", now).select("id");
    if (error)
      return { connection_id: conn.id, ok: false, reason: `DB_CLOSE_FAILED:${error.code}` };
    if (!closedRows?.length) continue;
    closed += 1;
    discrepancies.push({ kind: "flat_at_venue", pair: row.pair, side: row.side });
  }

  // Retry previously closed rows too: fill ingestion and flat observation may
  // arrive in either order. This RPC cannot alter open exposure or send orders.
  const closedPnl = await reconcileClosedPositionPnl(supabase, conn);
  const apexReportedPnl = await reconcileApexReportedPnl(supabase, conn);

  // Resting orders on a symbol with NO open position are invisible everywhere
  // else (they attach to no position row) yet they still block a new entry at
  // the signer with EXISTING_OPEN_ORDER. Surface them, read-only.
  const positionSymbols = new Set(positions.map((p) => String(p.symbol).toUpperCase()));
  const orphanOrders = orders
    .filter((o) => !positionSymbols.has(String(o.symbol ?? "").toUpperCase()))
    .map((o) => ({
      symbol: o.symbol ?? null,
      side: (o as Record<string, unknown>).side ?? null,
      type: (o as Record<string, unknown>).type ?? null,
      size: (o as Record<string, unknown>).size ?? null,
      price: (o as Record<string, unknown>).price ?? null,
      status: (o as Record<string, unknown>).status ?? null,
      id: (o as Record<string, unknown>).id ?? (o as Record<string, unknown>).orderId ?? null,
      client_id:
        (o as Record<string, unknown>).clientOrderId ??
        (o as Record<string, unknown>).clientId ??
        null,
    }));

  return {
    connection_id: conn.id,
    ok: !orderReconciliationRequired,
    position_snapshot_ok: true,
    order_reconciliation_required: orderReconciliationRequired,
    order_recovery: orderRecovery,
    pnl_history: pnlHistory,
    ...(orderReconciliationRequired ? { reason: "ORDER_RECONCILIATION_REQUIRED" } : {}),
    upserts,
    inserted,
    closed,
    closed_pnl_reconciliation: closedPnl,
    apex_reported_pnl: apexReportedPnl,
    open_orders: orders.length,
    open_positions_seen: positions.length,
    orphan_orders: orphanOrders,
    discrepancies,
    recon_source: reconSource,
    recon_version: RECON_VERSION,
    recon_at: now,
    open_orders_readable: true,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST" && req.method !== "GET") {
    return json(405, { error: "METHOD_NOT_ALLOWED" });
  }

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const timeoutMs = Number(Deno.env.get("APEX_READ_TIMEOUT_MS") || "15000");
  if (!url || !serviceKey) return json(500, { error: "SUPABASE_NOT_CONFIGURED" });

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const serviceReader = isAuthorizedServiceReader(req, serviceKey, Deno.env.get("SUPABASE_SECRET_KEYS"));
  let ownerId: string | null = null;
  if (!serviceReader) {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return json(401, { error: "SIGN_IN_REQUIRED" });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return json(401, { error: "SIGN_IN_REQUIRED" });
    ownerId = data.user.id;
  }
  let connectionQuery = selectReadableVenueConnections(supabase
    .from("exchange_connections")
    .select("id, user_id, exchange, environment, market_type, is_live, status"));
  if (ownerId) connectionQuery = connectionQuery.eq("user_id", ownerId);
  const { data: conns, error: connErr } = await connectionQuery;
  if (connErr) return json(500, { error: "CONN_QUERY_FAILED", code: connErr.code });

  const results = await reconcileConnections((conns ?? []) as ConnRow[], async (conn): Promise<Record<string, unknown>> => {
    // Single-flight: overlapping invocations (1-minute cron + manual runs)
    // previously interleaved read-then-write and churned the open rows,
    // which is what made the owner's live position briefly disappear.
    const { data: claimed, error: leaseErr } = await supabase.rpc("claim_live_recon_lease", {
      _connection_id: conn.id,
      _ttl_secs: 90,
    });
    if (leaseErr) {
      return { connection_id: conn.id, ok: false, reason: "LEASE_FAILED" };
    }
    if (claimed !== true) {
      return { connection_id: conn.id, ok: true, skipped: "cycle_already_running" };
    }

    let r: Record<string, unknown>;
    try {
      const [snapshot, equity] = await Promise.all([
        reconcileOne(supabase, conn, timeoutMs),
        observeAccountEquity(supabase, conn, timeoutMs),
      ]);
      r = snapshot;
      // These are account observations, never an entry authorization.
      await supabase.from("bot_events").insert({
        user_id: conn.user_id,
        event: "LIVE_ACCOUNT_EQUITY_OBSERVED",
        level: equity.ok ? "info" : "warning",
        detail: { connection_id: conn.id, venue: conn.exchange, ...equity },
      });
    } catch (err) {
      r = { connection_id: conn.id, ok: false, reason: "RECONCILIATION_UNAVAILABLE" };
    } finally {
      await supabase.rpc("release_live_recon_lease", { _connection_id: conn.id });
    }

    const nowIso = new Date().toISOString();
    if (r.skipped) {
      return r;
    }
    if (r.ok) {
      await supabase.from("bot_events").insert({
        user_id: conn.user_id,
        event: "LIVE_POSITION_RECONCILE_OK",
        level: "info",
        detail: {
          connection_id: conn.id,
          upserts: r.upserts ?? 0,
          inserted: r.inserted ?? 0,
          closed: r.closed ?? 0,
          closed_pnl_reconciliation: r.closed_pnl_reconciliation ?? null,
          apex_reported_pnl: r.apex_reported_pnl ?? null,
          order_recovery: r.order_recovery ?? null,
          pnl_history: r.pnl_history ?? null,
          open_orders: r.open_orders ?? 0,
          open_positions_seen: r.open_positions_seen ?? 0,
          discrepancies: r.discrepancies ?? [],
          recon_source: r.recon_source ?? "apex_omni_rest_v3",
          recon_version: r.recon_version ?? RECON_VERSION,
          transport: conn.exchange === "aster" ? "aster_signer_read" : "direct_apex",
        },
      });
      await supabase
        .from("exchange_connections")
        .update({ last_health_check_at: nowIso })
        .eq("id", conn.id);
    } else {
      await supabase.from("bot_events").insert({
        user_id: conn.user_id,
        event: "LIVE_POSITION_RECONCILE_FAIL",
        level: "error",
        detail: { connection_id: conn.id, reason: r.reason ?? "unknown",
          closed_pnl_reconciliation: r.closed_pnl_reconciliation ?? null,
          apex_reported_pnl: r.apex_reported_pnl ?? null,
          order_recovery: r.order_recovery ?? null,
          pnl_history: r.pnl_history ?? null,
          transport: conn.exchange === "aster" ? "aster_signer_read" : "direct_apex" },
      });
    }
    return r;
  }, conn => ({ connection_id: conn.id, ok: false, reason: "RECONCILIATION_UNAVAILABLE" }));
  return json(200, {
    ok: true,
    cycle_ts: new Date().toISOString(),
    count: results.length,
    results,
  });
});
