// ingest-live-fills — pull venue fills, FIFO-match to closed trades.
//
// OWNER RULING #12: this reader authenticates and signs its own GET
// requests against ApeX Omni IN-PROCESS. It does NOT call the signer
// container. Signer stays exclusively for order writes.
//
// FLOW
//   1. For every live ApeX connection, call ApeX /api/v3/fills directly
//      with the last known cursor (fill ts).
//   2. Insert new fills into public.live_fills (unique on
//      (connection_id, venue_fill_id) → replay is a no-op).
//   3. Advance live_fills_cursor.
//   4. Run FIFO matcher per (connection_id, symbol) using fills with
//      residual_size > 0. Same-direction fills add lots; opposite fills
//      close FIFO. Partial closes leave a residual lot open.
//   5. Insert one row per closed trade into public.trades (book='live',
//      venue order/fill ids, fees_usd). Unique index
//      trades_conn_exit_fill_uidx makes reruns idempotent.
//   6. Upsert residual open lots into public.positions (source='live',
//      status='open') as weighted-average entry, size = sum residuals.
//
// SAFETY
//   * READ-ONLY at venue (GET /api/v3/fills only).
//   * Service-role DB writes only.
//   * Never touches paper rows: every read/write filters source='live'
//     / book='live'.
//   * Idempotent — safe to run every cycle and to backfill from empty
//     cursor. Fees pro-rated per close-quantity.
//   * No secrets logged. No raw venue payloads returned.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { fetchFills, loadApexReadCreds, type NormalizedFill } from "../_shared/apex-omni-read.ts";
import { readAster, asterFills, asterReadFailure } from "../_shared/aster-signer-read.ts";
import { selectReadableVenueConnections } from "../_shared/venue-read-policy.ts";
import { isAuthorizedServiceReader } from "../_shared/service-reader-auth.ts";

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

interface LotRow {
  id: string;
  venue_fill_id: string;
  venue_order_id: string | null;
  symbol: string;
  side: "BUY" | "SELL";
  price: string; // numeric as string
  size: string;
  fee: string;
  residual_size: string;
  fill_ts: string; // iso
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SB = SupabaseClient;

async function ingestOne(supabase: SB, conn: ConnRow, opts: { timeoutMs: number }) {
  // --- 1. Cursor ---------------------------------------------------------
  const { data: cursor, error: cursorError } = await supabase
    .from("live_fills_cursor")
    .select("last_fill_ts, last_fill_id")
    .eq("connection_id", conn.id)
    .maybeSingle();
  if (cursorError) return { connection_id: conn.id, ok: false, reason: "FILL_CURSOR_READ_FAILED" };
  // Poll from 5s BEFORE cursor to catch any late-landing sibling fills; the
  // unique venue_fill_id index makes overlap a no-op.
  const sinceTsMs = cursor?.last_fill_ts ? Date.parse(cursor.last_fill_ts) - 5000 : null;

  // --- 2. Pull fills DIRECTLY from ApeX (no signer) ---------------------
  let fills: NormalizedFill[];
  let completeThrough: number | null = null;
  if (conn.exchange === "aster") {
    try {
      ({ fills, completeThrough } = asterFills(await readAster(conn, "fills", { since_ts_ms: sinceTsMs }, opts)));
    } catch (error) {
      return { connection_id: conn.id, ok: false, reason: asterReadFailure(error, "ASTER_FILLS_READ_FAILED") };
    }
  } else {
  const credLoad = await loadApexReadCreds(supabase, conn.id, conn.environment ?? "mainnet");
  if (!credLoad.ok) return { connection_id: conn.id, ok: false, reason: credLoad.reason };
  const resp = await fetchFills(credLoad.creds, sinceTsMs, 500, opts.timeoutMs);
  if (!resp.ok) return { connection_id: conn.id, ok: false, reason: resp.reason };
  fills = resp.fills;
  }

  // --- 3. Idempotent insert into live_fills -----------------------------
  let inserted = 0;
  let latestTs = cursor?.last_fill_ts ? Date.parse(cursor.last_fill_ts) : 0;
  let latestId = cursor?.last_fill_id ?? null;
  for (const f of fills) {
    const iso = new Date(f.fill_ts_ms).toISOString();
    const row = {
      user_id: conn.user_id,
      connection_id: conn.id,
      venue: conn.exchange,
      venue_fill_id: f.venue_fill_id,
      venue_order_id: f.venue_order_id,
      symbol: f.symbol,
      side: f.side,
      price: f.price,
      size: f.size,
      fee: f.fee,
      fee_currency: f.fee_currency,
      liquidity: f.liquidity,
      fill_ts: iso,
      residual_size: f.size,
      raw: {},
    };
    const { error, count } = await supabase
      .from("live_fills")
      .upsert(row, {
        onConflict: "connection_id,venue_fill_id",
        ignoreDuplicates: true,
        count: "exact",
      });
    if (error) return { connection_id: conn.id, ok: false, reason: `FILL_INSERT:${error.code}` };
    if ((count ?? 0) > 0) inserted += 1;
    if (f.fill_ts_ms > latestTs) {
      latestTs = f.fill_ts_ms;
      latestId = f.venue_fill_id;
    }
  }

  // Advance cursor if we made forward progress.
  if (completeThrough !== null) latestTs = Math.max(latestTs, completeThrough);
  if (latestTs > 0) {
    const { error: cursorWriteError } = await supabase.from("live_fills_cursor").upsert(
      {
        connection_id: conn.id,
        user_id: conn.user_id,
        last_fill_ts: new Date(latestTs).toISOString(),
        last_fill_id: latestId,
        last_polled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "connection_id" },
    );
    if (cursorWriteError) return { connection_id: conn.id, ok: false, reason: "FILL_CURSOR_WRITE_FAILED" };
  }

  // --- 4. FIFO matcher --------------------------------------------------
  const { closedTrades, residualLots } = await runMatcher(supabase, conn);

  // --- 5. Write closed trades ------------------------------------------
  let tradesWritten = 0;
  let realizedTotal = 0;
  for (const t of closedTrades) {
    // Idempotent: unique (connection_id, exit_venue_fill_id).
    const { error } = await supabase.from("trades").insert(t.row);
    if (error && !/duplicate key/i.test(error.message)) {
      return { connection_id: conn.id, ok: false, reason: `TRADE_INSERT:${error.code}` };
    }
    if (!error) {
      tradesWritten += 1;
      realizedTotal += Number(t.row.realized_pnl);
    }
    // Persist residuals (matched_at / residual_size) for both fills.
    for (const u of t.updates) {
      const { error: uerr } = await supabase.from("live_fills").update(u.patch).eq("id", u.id);
      if (uerr) return { connection_id: conn.id, ok: false, reason: `FILL_PATCH:${uerr.code}` };
    }
  }

  // --- 6. Residual accounting only (NO position writes) -----------------
  //
  // OWNER RULING: ApeX is authoritative for open exposure. This matcher
  // reconstructs positions from OUR fill history, which is necessarily a
  // partial view (manual venue trades, pre-existing exposure and partial
  // ingestion are invisible to it). It used to upsert and CLOSE rows in
  // public.positions on the same 1-minute cadence as
  // reconcile-live-positions, so the two jobs continuously overwrote and
  // closed each other's rows — which is why the owner's real ETH/BTC
  // exposure intermittently vanished from the app.
  //
  // reconcile-live-positions is now the ONLY writer of source='live'
  // position rows. This function reports residuals for observability and
  // leaves exposure state alone.
  const residualsBySymbolSide = new Map<
    string,
    {
      symbol: string;
      sideDb: "long" | "short";
      qty: number;
      notional: number;
      feeSum: number;
      ts: string;
      venueOrderId: string | null;
    }
  >();
  for (const lot of residualLots) {
    const key = `${lot.symbol}::${lot.side}`;
    const qty = Number(lot.residual_size);
    if (qty <= 0) continue;
    const px = Number(lot.price);
    const cur = residualsBySymbolSide.get(key);
    if (cur) {
      cur.qty += qty;
      cur.notional += qty * px;
      cur.feeSum += Number(lot.fee) * (qty / Number(lot.size));
    } else {
      residualsBySymbolSide.set(key, {
        symbol: lot.symbol,
        sideDb: lot.side === "BUY" ? "long" : "short",
        qty,
        notional: qty * px,
        feeSum: Number(lot.fee) * (qty / Number(lot.size)),
        ts: lot.fill_ts,
        venueOrderId: lot.venue_order_id,
      });
    }
  }

  return {
    connection_id: conn.id,
    ok: true,
    fills_ingested: inserted,
    trades_written: tradesWritten,
    realized_total: realizedTotal,
    residual_lots: residualLots.length,
    residual_keys: Array.from(residualsBySymbolSide.keys()),
    position_writes: "disabled_venue_authoritative",
  };
}

// FIFO matcher: consumes live_fills with residual_size > 0 for this
// connection, produces closed trades. Deterministic (orders by fill_ts,
// venue_fill_id ascending).
async function runMatcher(
  supabase: SB,
  conn: ConnRow,
): Promise<{
  closedTrades: Array<{
    row: Record<string, unknown>;
    updates: Array<{ id: string; patch: Record<string, unknown> }>;
  }>;
  residualLots: LotRow[];
}> {
  const { data, error } = await supabase
    .from("live_fills")
    .select(
      "id, venue_fill_id, venue_order_id, symbol, side, price, size, fee, residual_size, fill_ts",
    )
    .eq("connection_id", conn.id)
    .gt("residual_size", 0)
    .order("fill_ts", { ascending: true })
    .order("venue_fill_id", { ascending: true });
  if (error) throw new Error(`matcher_read: ${error.code}`);
  const rows = (data ?? []) as LotRow[];

  // Per-symbol lot queue keyed by direction we're LONG on
  // (i.e. lots that BUY-added when net-long, or SELL-added when net-short).
  const bySymbol = new Map<string, LotRow[]>();
  for (const r of rows) {
    const arr = bySymbol.get(r.symbol) ?? [];
    arr.push({ ...r });
    bySymbol.set(r.symbol, arr);
  }

  const closedTrades: Array<{
    row: Record<string, unknown>;
    updates: Array<{ id: string; patch: Record<string, unknown> }>;
  }> = [];
  const residualsOut: LotRow[] = [];
  const attributionCache = new Map<
    string,
    {
      wallet_connection_id: string | null;
      autopilot_workflow_id: string | null;
      strategy_id: string | null;
      decision_id: string | null;
    }
  >();

  for (const [symbol, chrono] of bySymbol) {
    // openSide is null when flat; otherwise the venue side ("BUY" for long, "SELL" for short) of the lots stack.
    let openSide: "BUY" | "SELL" | null = null;
    let lots: LotRow[] = [];
    for (const f of chrono) {
      if (!openSide || openSide === f.side) {
        // Add to lots.
        openSide = f.side;
        lots.push({ ...f });
        continue;
      }
      // Opposite side → FIFO close against lots.
      let remaining = Number(f.residual_size);
      let exitFeeRemaining = Number(f.fee) * (remaining / Number(f.size)); // pro-rated fee for this fill's usage
      const closesFromThisFill: Array<{
        open: LotRow;
        qty: number;
        entryFee: number;
        exitFee: number;
      }> = [];
      while (remaining > 1e-12 && lots.length > 0) {
        const open = lots[0];
        const openRes = Number(open.residual_size);
        const closeQty = Math.min(openRes, remaining);
        const entryFee = Number(open.fee) * (closeQty / Number(open.size));
        const exitFee = Number(f.fee) * (closeQty / Number(f.size));
        closesFromThisFill.push({ open, qty: closeQty, entryFee, exitFee });
        open.residual_size = String(openRes - closeQty);
        remaining -= closeQty;
        exitFeeRemaining -= exitFee;
        if (Number(open.residual_size) <= 1e-12) {
          lots.shift();
        }
      }

      // Build one trades row PER opposite fill (aggregating multiple opens
      // it closed). Exit fill id is the unique key.
      if (closesFromThisFill.length > 0) {
        const totalQty = closesFromThisFill.reduce((s, x) => s + x.qty, 0);
        const weightedEntryNotional = closesFromThisFill.reduce(
          (s, x) => s + x.qty * Number(x.open.price),
          0,
        );
        const avgEntry = weightedEntryNotional / totalQty;
        const exitPrice = Number(f.price);
        const sign = openSide === "BUY" ? 1 : -1;
        const grossPnl = (exitPrice - avgEntry) * totalQty * sign;
        const feesSum = closesFromThisFill.reduce((s, x) => s + x.entryFee + x.exitFee, 0);
        const realized = grossPnl - feesSum;
        const notional = avgEntry * totalQty;
        const pnlPct = notional > 0 ? (realized / notional) * 100 : 0;
        const openedAt = closesFromThisFill[0].open.fill_ts;
        const tradeSide = openSide === "BUY" ? "long" : "short";
        const attributionKey = `${symbol}::${tradeSide}`;
        let attribution = attributionCache.get(attributionKey);
        if (!attribution) {
          const { data: positionAttribution, error: attributionError } = await supabase
            .from("positions")
            .select("wallet_connection_id,autopilot_workflow_id,strategy_id,decision_id")
            .eq("user_id", conn.user_id)
            .eq("connection_id", conn.id)
            .eq("source", "live")
            .eq("pair", symbol)
            .eq("side", tradeSide)
            .order("opened_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (attributionError) throw new Error(`trade_attribution: ${attributionError.code}`);
          attribution = {
            wallet_connection_id: positionAttribution?.wallet_connection_id ?? null,
            autopilot_workflow_id: positionAttribution?.autopilot_workflow_id ?? null,
            strategy_id: positionAttribution?.strategy_id ?? null,
            decision_id: positionAttribution?.decision_id ?? null,
          };
          attributionCache.set(attributionKey, attribution);
        }

        closedTrades.push({
          row: {
            user_id: conn.user_id,
            connection_id: conn.id,
            wallet_connection_id: attribution.wallet_connection_id,
            autopilot_workflow_id: attribution.autopilot_workflow_id,
            strategy_id: attribution.strategy_id,
            decision_id: attribution.decision_id,
            exchange: conn.exchange,
            market_type: conn.market_type || "futures",
            pair: symbol,
            side: tradeSide,
            entry_price: avgEntry,
            exit_price: exitPrice,
            size: totalQty,
            realized_pnl: realized,
            realized_pnl_pct: pnlPct,
            opened_at: openedAt,
            closed_at: f.fill_ts,
            book: "live",
            evidence_verified: true,
            evidence_source: "venue_fill_reconciliation",
            evidence_verified_at: new Date().toISOString(),
            venue: conn.exchange,
            venue_order_id: f.venue_order_id,
            entry_venue_fill_id: closesFromThisFill[0].open.venue_fill_id,
            exit_venue_fill_id: f.venue_fill_id,
            fees_usd: feesSum,
          },
          updates: [
            // Patch each open lot's residual
            ...closesFromThisFill.map((c) => ({
              id: c.open.id,
              patch: {
                residual_size: c.open.residual_size,
                matched_at: Number(c.open.residual_size) <= 1e-12 ? new Date().toISOString() : null,
              } as Record<string, unknown>,
            })),
            // Patch this closing fill
            {
              id: f.id,
              patch: {
                residual_size: String(Math.max(0, remaining)),
                matched_at: remaining <= 1e-12 ? new Date().toISOString() : null,
              } as Record<string, unknown>,
            },
          ],
        });
      }

      if (remaining > 1e-12) {
        // Closing fill exceeded open lots → flip direction with the leftover.
        openSide = f.side;
        lots = [{ ...f, residual_size: String(remaining) }];
      } else if (lots.length === 0) {
        openSide = null;
      }
    }

    // Anything left in `lots` is residual open exposure.
    for (const l of lots) {
      if (Number(l.residual_size) > 1e-12) residualsOut.push(l);
    }
  }

  return { closedTrades, residualLots: residualsOut };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST" && req.method !== "GET") {
    return json(405, { error: "METHOD_NOT_ALLOWED" });
  }

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!isAuthorizedServiceReader(req, serviceKey, Deno.env.get("SUPABASE_SECRET_KEYS"))) {
    // Distinguish a handler rejection from the platform JWT gateway without
    // logging credentials, claims, hashes, or account information.
    console.warn("LIVE_FILLS_AUTH_REJECTED", {
      service_key_configured: Boolean(serviceKey),
      bearer_present: (req.headers.get("authorization") ?? "").startsWith("Bearer "),
    });
    return json(401, { error: "SERVICE_ROLE_REQUIRED" });
  }
  const timeoutMs = Number(Deno.env.get("APEX_READ_TIMEOUT_MS") || "15000");
  if (!url || !serviceKey) return json(500, { error: "SUPABASE_NOT_CONFIGURED" });

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Account observation continues while order routing is paused.
  const { data: conns, error: connErr } = await selectReadableVenueConnections(supabase
    .from("exchange_connections")
    .select("id, user_id, exchange, environment, market_type, is_live, status"));
  if (connErr) return json(500, { error: "CONN_QUERY_FAILED", code: connErr.code });

  const results: Array<Record<string, unknown>> = [];
  for (const conn of (conns ?? []) as ConnRow[]) {
    let r: Record<string, unknown>;
    try {
      r = await ingestOne(supabase, conn, { timeoutMs });
    } catch (err) {
      const msg = (err as Error)?.message || "UNKNOWN";
      r = { connection_id: conn.id, ok: false, reason: msg.slice(0, 200) };
    }
    results.push(r);

    // Telemetry — success AND failure both write bot_events (ruling #10 §5).
    if (r.ok) {
      await supabase.from("bot_events").insert({
        user_id: conn.user_id,
        event: "LIVE_FILLS_INGEST_OK",
        level: "info",
        detail: {
          connection_id: conn.id,
          fills_inserted: r.fills_ingested ?? 0,
          trades_written: r.trades_written ?? 0,
          realized_pnl: r.realized_total ?? 0,
        },
      });
    } else {
      await supabase.from("bot_events").insert({
        user_id: conn.user_id,
        event: "LIVE_FILLS_INGEST_FAIL",
        level: "error",
        detail: { connection_id: conn.id, reason: r.reason ?? "unknown" },
      });
    }
  }
  return json(200, {
    ok: true,
    cycle_ts: new Date().toISOString(),
    count: results.length,
    results,
  });
});
