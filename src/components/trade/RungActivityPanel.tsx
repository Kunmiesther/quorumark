/**
 * RungActivityPanel — read-only live view of rung activity.
 *
 * Replaces the previous static DCA Rung Allocation editor (R1-R8 % inputs).
 * This is a content replacement, not a restyle: same card surface, uppercase
 * micro-labels, solid purple/teal/red accents, compact rows.
 *
 * DATA SOURCES (per book):
 *   paper: public.paper_positions.fills[]   (open rungs, per-fill price/size)
 *          public.paper_positions.pending_rungs[]     (placed, not filled)
 *          public.paper_positions.strategy            (leg: accumulator/…)
 *          public.paper_trades  (closed rungs with realized P&L, filtered
 *                                by closed_at >= UTC start-of-day)
 *   live:  public.live_fills               (each fill = one rung)
 *          public.positions (source='live', open_orders jsonb → pending)
 *          public.trades (book='live', closed_at >= UTC start-of-day)
 *          Leg name is not tracked on live yet → renders "—".
 *
 * DAY BOUNDARY: UTC midnight — same as bill period keys / Life Map
 * (src/lib/bills/allocate.ts uses getUTCFullYear/getUTCMonth). No local-TZ
 * bleed between days.
 *
 * TALLY: rungs OPEN today = fills whose position/lot is still open;
 *         rungs CLOSED today = closed trades with closed_at >= start-of-day.
 *         PENDING doesn't count toward the day tally (not yet fired).
 *
 * EMPTY STATE: "No rungs fired today" — a single compact line, not eight
 * zero rows.
 *
 * GUARDS: read-only UI + reads. No writes, no engine/schema/flag changes.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

type Book = "paper" | "live";

type RungState = "filled" | "closed" | "pending";

interface RungRow {
  key: string;
  leg: string; // Vanguard / Accumulator / Sweep / Hunter / Arbiter / —
  symbol: string;
  side: "long" | "short";
  rungIndex: number; // 1-based; 0 when unknown
  price: number | null;
  size: number | null;
  state: RungState;
  realizedPnl?: number | null;
  ts: number; // ms — for sort within group
}

const LEG_ALIASES: Record<string, string> = {
  accumulator: "Accumulator",
  vanguard: "Vanguard",
  sweep: "Sweep",
  hunter: "Hunter",
  arbiter: "Arbiter",
};

function prettyLeg(raw: string | null | undefined): string {
  if (!raw) return "—";
  const key = String(raw).trim().toLowerCase();
  return LEG_ALIASES[key] ?? raw.toString().slice(0, 12);
}

function startOfUtcDayMs(now: number = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Exported for tests — day tally logic must be deterministic and TZ-safe.
export function computeTally(rows: RungRow[]): {
  open: number;
  closed: number;
  pending: number;
  total: number;
} {
  let open = 0;
  let closed = 0;
  let pending = 0;
  for (const r of rows) {
    if (r.state === "filled") open += 1;
    else if (r.state === "closed") closed += 1;
    else if (r.state === "pending") pending += 1;
  }
  return { open, closed, pending, total: open + closed };
}

// Exported for tests — sizes/prices coerce to finite numbers or null.
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function loadPaperRows(userId: string, sinceMs: number): Promise<RungRow[]> {
  const [{ data: openPos, error: openErr }, { data: closedTr, error: closedErr }] =
    await Promise.all([
      supabase
        .from("paper_positions")
        .select(
          "id, symbol, direction, strategy, fills, pending_rungs, rung_count, status, entry_ts",
        )
        .eq("user_id", userId)
        .eq("status", "open"),
      supabase
        .from("paper_trades")
        .select("id, symbol, direction, exit_price, pnl_net, closed_at, position_id, size_qty")
        .eq("user_id", userId)
        .gte("closed_at", new Date(sinceMs).toISOString())
        .order("closed_at", { ascending: false })
        .limit(200),
    ]);
  if (openErr) throw new Error(openErr.message);
  if (closedErr) throw new Error(closedErr.message);

  const rows: RungRow[] = [];

  for (const p of openPos ?? []) {
    const leg = prettyLeg((p as { strategy?: string }).strategy);
    const symbol = String((p as { symbol?: string }).symbol ?? "");
    const side = ((p as { direction?: string }).direction === "short" ? "short" : "long") as
      "long" | "short";
    const fills = Array.isArray((p as { fills?: unknown }).fills)
      ? (p as { fills: unknown[] }).fills
      : [];
    fills.forEach((f, i) => {
      const obj = (f ?? {}) as Record<string, unknown>;
      const ts = num(obj.ts ?? obj.timestamp ?? obj.time) ?? 0;
      rows.push({
        key: `pp-${(p as { id: string }).id}-f${i}`,
        leg,
        symbol,
        side,
        rungIndex: i + 1,
        price: num(obj.price ?? obj.fill_price ?? obj.vwap),
        size: num(obj.size ?? obj.qty ?? obj.size_qty),
        state: "filled",
        ts,
      });
    });
    const pending = Array.isArray((p as { pending_rungs?: unknown }).pending_rungs)
      ? (p as { pending_rungs: unknown[] }).pending_rungs
      : [];
    pending.forEach((r, i) => {
      const obj = (r ?? {}) as Record<string, unknown>;
      rows.push({
        key: `pp-${(p as { id: string }).id}-p${i}`,
        leg,
        symbol,
        side,
        rungIndex: fills.length + i + 1,
        price: num(obj.price ?? obj.trigger ?? obj.limit_price),
        size: num(obj.size ?? obj.qty),
        state: "pending",
        ts: 0,
      });
    });
  }

  for (const t of closedTr ?? []) {
    const leg = "—"; // paper_trades doesn't carry strategy directly — grouping still lands on symbol/side
    rows.push({
      key: `pt-${(t as { id: string }).id}`,
      leg,
      symbol: String((t as { symbol?: string }).symbol ?? ""),
      side: ((t as { direction?: string }).direction === "short" ? "short" : "long") as
        "long" | "short",
      rungIndex: 0,
      price: num((t as { exit_price?: number }).exit_price),
      size: num((t as { size_qty?: number }).size_qty),
      state: "closed",
      realizedPnl: num((t as { pnl_net?: number }).pnl_net),
      ts: Date.parse(String((t as { closed_at?: string }).closed_at ?? "")) || 0,
    });
  }

  return rows;
}

async function loadLiveRows(userId: string, sinceMs: number): Promise<RungRow[]> {
  const [
    { data: fills, error: fillsErr },
    { data: closed, error: closedErr },
    { data: openPos, error: openErr },
  ] = await Promise.all([
    supabase
      .from("live_fills")
      .select("id, symbol, side, price, size, fill_ts, residual_size, matched_at")
      .eq("user_id", userId)
      .gt("residual_size", 0)
      .order("fill_ts", { ascending: true })
      .limit(200),
    supabase
      .from("trades")
      .select("id, pair, side, exit_price, realized_pnl, closed_at, size")
      .eq("book", "live")
      .eq("user_id", userId)
      .gte("closed_at", new Date(sinceMs).toISOString())
      .order("closed_at", { ascending: false })
      .limit(200),
    supabase
      .from("positions")
      .select("pair, side, open_orders")
      .eq("user_id", userId)
      .eq("source", "live")
      .eq("status", "open"),
  ]);
  // One source can lag a migration or be temporarily unavailable without
  // blanking the entire operator panel. Render the sources that answered and
  // fail only when the whole live rung read is unavailable.
  if (fillsErr && closedErr && openErr) {
    throw new Error([fillsErr.message, closedErr.message, openErr.message].join(" · "));
  }

  const rows: RungRow[] = [];

  // Group open fills by (symbol, side) to compute rung index within the lot stack.
  const perGroup = new Map<string, number>();
  for (const f of fills ?? []) {
    const sym = String((f as { symbol?: string }).symbol ?? "");
    const venueSide = String((f as { side?: string }).side ?? "").toUpperCase();
    const posSide: "long" | "short" = venueSide === "SELL" ? "short" : "long";
    const gk = `${sym}::${posSide}`;
    const idx = (perGroup.get(gk) ?? 0) + 1;
    perGroup.set(gk, idx);
    rows.push({
      key: `lf-${(f as { id: string }).id}`,
      leg: "—", // live positions don't track leg yet — reported to owner
      symbol: sym,
      side: posSide,
      rungIndex: idx,
      price: num((f as { price?: number }).price),
      size: num((f as { residual_size?: number }).residual_size),
      state: "filled",
      ts: Date.parse(String((f as { fill_ts?: string }).fill_ts ?? "")) || 0,
    });
  }

  for (const t of closed ?? []) {
    rows.push({
      key: `tr-${(t as { id: string }).id}`,
      leg: "—",
      symbol: String((t as { pair?: string }).pair ?? ""),
      side: ((t as { side?: string }).side === "short" ? "short" : "long") as "long" | "short",
      rungIndex: 0,
      price: num((t as { exit_price?: number }).exit_price),
      size: num((t as { size?: number }).size),
      state: "closed",
      realizedPnl: num((t as { realized_pnl?: number }).realized_pnl),
      ts: Date.parse(String((t as { closed_at?: string }).closed_at ?? "")) || 0,
    });
  }

  for (const p of openPos ?? []) {
    const orders = Array.isArray((p as { open_orders?: unknown }).open_orders)
      ? (p as { open_orders: unknown[] }).open_orders
      : [];
    const sym = String((p as { pair?: string }).pair ?? "");
    const side = ((p as { side?: string }).side === "short" ? "short" : "long") as "long" | "short";
    orders.forEach((o, i) => {
      const obj = (o ?? {}) as Record<string, unknown>;
      // Only include reduce-only or pending open-ladder orders. Skip fills.
      const status = String(obj.status ?? "").toLowerCase();
      if (status === "filled" || status === "cancelled") return;
      rows.push({
        key: `oo-${sym}-${side}-${i}`,
        leg: "—",
        symbol: sym,
        side,
        rungIndex: i + 1,
        price: num(obj.price ?? obj.trigger_price ?? obj.limit_price),
        size: num(obj.size ?? obj.qty),
        state: "pending",
        ts: 0,
      });
    });
  }

  return rows;
}

function groupBySymbolLeg(
  rows: RungRow[],
): Array<{ symbol: string; leg: string; side: "long" | "short"; items: RungRow[] }> {
  const map = new Map<
    string,
    { symbol: string; leg: string; side: "long" | "short"; items: RungRow[] }
  >();
  for (const r of rows) {
    const key = `${r.symbol}::${r.leg}::${r.side}`;
    let group = map.get(key);
    if (!group) {
      group = { symbol: r.symbol, leg: r.leg, side: r.side, items: [] };
      map.set(key, group);
    }
    group.items.push(r);
  }
  // Sort each group: closed/filled by ts asc (rung order), pending after.
  for (const g of map.values()) {
    g.items.sort((a, b) => {
      const stateOrder = (s: RungState) => (s === "filled" ? 0 : s === "closed" ? 1 : 2);
      const so = stateOrder(a.state) - stateOrder(b.state);
      if (so !== 0) return so;
      if (a.rungIndex !== b.rungIndex) return a.rungIndex - b.rungIndex;
      return a.ts - b.ts;
    });
  }
  return Array.from(map.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function fmtPrice(p: number | null): string {
  if (p == null) return "—";
  if (Math.abs(p) >= 1000) return p.toFixed(1);
  if (Math.abs(p) >= 1) return p.toFixed(3);
  return p.toFixed(5);
}
function fmtSize(s: number | null): string {
  if (s == null) return "—";
  const a = Math.abs(s);
  if (a >= 100) return s.toFixed(2);
  if (a >= 1) return s.toFixed(3);
  return s.toFixed(4);
}
function fmtPnl(v: number | null | undefined): string {
  if (v == null) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}$${Math.abs(v)
    .toFixed(2)
    .replace(/^/, v < 0 ? "-" : "")}`;
}

export function RungActivityPanel({ book }: { book: Book }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const sinceMs = startOfUtcDayMs();

  const q = useQuery({
    queryKey: ["rung-activity", book, userId, sinceMs],
    queryFn: async () =>
      book === "paper" ? loadPaperRows(userId!, sinceMs) : loadLiveRows(userId!, sinceMs),
    enabled: !!userId,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const rows = q.data ?? [];
  const tally = useMemo(() => computeTally(rows), [rows]);
  const groups = useMemo(() => groupBySymbolLeg(rows), [rows]);
  const nothingToday = tally.open === 0 && tally.closed === 0;

  return (
    <div data-testid="rung-activity-panel">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-white/60">
          Rung Activity · Today (UTC)
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[10.5px] font-bold tabular-nums">
          <span style={{ color: "var(--onixus-purple)" }}>OPEN {tally.open}</span>
          <span className="text-white/25">·</span>
          <span style={{ color: "var(--onixus-teal)" }}>CLOSED {tally.closed}</span>
          <span className="text-white/25">·</span>
          <span className="text-white/70">FIRED {tally.total}</span>
        </span>
      </div>

      {q.isLoading ? (
        <div className="rounded-md border border-white/[0.06] bg-[color:var(--surface-2)] px-3 py-2 text-[11px] text-white/40">
          Loading rung activity…
        </div>
      ) : q.error ? (
        <div className="rounded-md border border-[color:var(--onixus-red)]/40 bg-[color:var(--onixus-red)]/10 px-3 py-2 text-[11px] text-[color:var(--onixus-red)]">
          Rung activity read failed.
        </div>
      ) : nothingToday && tally.pending === 0 ? (
        <div className="rounded-md border border-white/[0.06] bg-[color:var(--surface-2)] px-3 py-2 text-center text-[11px] uppercase tracking-[0.12em] text-white/40">
          No rungs fired today
        </div>
      ) : (
        <div
          className="space-y-2 max-h-[280px] overflow-y-auto pr-1"
          data-testid="rung-activity-rows"
        >
          {groups.map((g) => (
            <div
              key={`${g.symbol}::${g.leg}::${g.side}`}
              className="rounded-md border border-white/[0.06] bg-[color:var(--surface-2)]/60 p-1.5"
            >
              <div className="flex items-center justify-between gap-2 px-1 pb-1">
                <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-white/75">
                  <span
                    className="rounded px-1.5 py-[1px] text-[9.5px] font-bold text-white"
                    style={{ background: "var(--onixus-purple)" }}
                  >
                    {g.leg}
                  </span>
                  <span>{g.symbol.replace("-", "/")}</span>
                  <span
                    className={cn(
                      "text-[9.5px]",
                      g.side === "long"
                        ? "text-[color:var(--onixus-teal)]"
                        : "text-[color:var(--onixus-red)]",
                    )}
                  >
                    {g.side.toUpperCase()}
                  </span>
                </span>
                <span className="font-mono text-[10px] tabular-nums text-white/45">
                  {g.items.length} rung{g.items.length === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="space-y-[3px]">
                {g.items.map((r) => (
                  <RungRowLine key={r.key} row={r} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RungRowLine({ row }: { row: RungRow }) {
  const stateColor =
    row.state === "closed"
      ? row.realizedPnl != null && row.realizedPnl < 0
        ? "var(--onixus-red)"
        : "var(--onixus-teal)"
      : row.state === "pending"
        ? "color-mix(in oklab, white 40%, transparent)"
        : "var(--onixus-purple)";

  const stateLabel =
    row.state === "closed" ? "CLOSED" : row.state === "pending" ? "PENDING" : "FILLED";

  return (
    <li
      className="grid grid-cols-[46px_1fr_auto] items-center gap-2 rounded px-1.5 py-1 font-mono text-[10.5px] tabular-nums"
      data-testid="rung-row"
    >
      <span className="font-bold text-white/70">
        {row.rungIndex > 0 ? `R${row.rungIndex}` : "—"}
      </span>
      <span className="flex items-center gap-2 text-white/70">
        <span className="text-white/85">@ {fmtPrice(row.price)}</span>
        <span className="text-white/45">× {fmtSize(row.size)}</span>
        {row.state === "closed" && row.realizedPnl != null ? (
          <span
            className="ml-auto text-[10px]"
            style={{ color: row.realizedPnl >= 0 ? "var(--onixus-teal)" : "var(--onixus-red)" }}
          >
            {fmtPnl(row.realizedPnl)}
          </span>
        ) : null}
      </span>
      <span
        className="rounded px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-[0.14em]"
        style={{
          color: stateColor,
          background: `color-mix(in oklab, ${stateColor} 12%, transparent)`,
        }}
      >
        {stateLabel}
      </span>
    </li>
  );
}

// Test-only exports.
export const __internals__ = { startOfUtcDayMs, groupBySymbolLeg, prettyLeg };
