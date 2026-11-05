/**
 * TradeHistoryCard — closed trades table for the active desk book.
 *
 * Data sources (read-only, no mutations):
 *   • book="paper" → public.paper_trades (columns: symbol, direction,
 *     entry_price, exit_price, size_qty, pnl_net, pnl_gross, fees,
 *     exit_reason, hold_seconds, closed_at). Leg/bot is derived from the
 *     parent paper_positions.strategy row.
 *   • book="live"  → public.trades, with its strategy_id resolved against
 *     public.strategies. Missing attribution is displayed, never inferred.
 *
 * Empty state is honest: "No closed trades yet ({book})".
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Share2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { PairBadge } from "@/components/trade/PairBadge";
import { shareTrade } from "@/lib/social/shareTrade";

type Book = "paper" | "live";

interface ClosedTrade {
  id: string;
  closedAt: string;
  symbol: string;
  leg: string | null;
  direction: "long" | "short";
  size: number;
  entry: number;
  exit: number;
  pnl: number;
  fees: number;
  exitReason: string;
  durationSec: number;
}

const PAGE_SIZE = 50;

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}
function fmtUsd(n: number | null | undefined, digits = 2): string {
  const s = fmtNum(n, digits);
  return s === "—" ? s : `$${s}`;
}
function fmtDuration(sec: number | null | undefined): string {
  const s = Number(sec ?? 0);
  if (!Number.isFinite(s) || s <= 0) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hr = h % 24;
  return hr ? `${d}d ${hr}h` : `${d}d`;
}
function reasonLabel(raw: string | null | undefined): string {
  const r = (raw ?? "").toLowerCase();
  if (!r) return "—";
  if (r.includes("tp3")) return "TP3";
  if (r.includes("tp2")) return "TP2";
  if (r.includes("tp1") || r === "tp_touch") return "TP";
  if (r.includes("stop") || r === "sl") return "STOP";
  if (r.includes("time") || r.includes("expire")) return "TIMEOUT";
  if (r.includes("manual") || r.includes("user")) return "MANUAL";
  return raw!.toUpperCase();
}

function usePaperHistory(userId: string | undefined, limit: number) {
  return useQuery({
    queryKey: ["trade-history", "paper", userId, limit],
    enabled: !!userId,
    refetchInterval: 30_000,
    queryFn: async (): Promise<ClosedTrade[]> => {
      const { data: trades, error } = await supabase
        .from("paper_trades")
        .select(
          "id, symbol, direction, entry_price, exit_price, size_qty, pnl_net, fees, exit_reason, hold_seconds, closed_at, position_id",
        )
        .eq("user_id", userId!)
        .order("closed_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      const rows = trades ?? [];
      const posIds = Array.from(new Set(rows.map((r) => r.position_id).filter(Boolean))) as string[];
      const legMap = new Map<string, string>();
      if (posIds.length) {
        const { data: positions } = await supabase
          .from("paper_positions")
          .select("id, strategy")
          .in("id", posIds);
        for (const p of positions ?? []) legMap.set(p.id as string, (p.strategy as string) ?? "—");
      }
      return rows.map((r) => ({
        id: String(r.id),
        closedAt: r.closed_at ?? "",
        symbol: String(r.symbol),
        leg: legMap.get(r.position_id as string) ?? null,
        direction: (r.direction as "long" | "short") ?? "long",
        size: Number(r.size_qty ?? 0),
        entry: Number(r.entry_price ?? 0),
        exit: Number(r.exit_price ?? 0),
        pnl: Number(r.pnl_net ?? 0),
        fees: Number(r.fees ?? 0),
        exitReason: reasonLabel(r.exit_reason as string | null),
        durationSec: Number(r.hold_seconds ?? 0),
      }));
    },
  });
}

function useLiveHistory(userId: string | undefined, limit: number) {
  return useQuery({
    queryKey: ["trade-history", "live", userId, limit],
    enabled: !!userId,
    refetchInterval: 30_000,
    queryFn: async (): Promise<ClosedTrade[]> => {
      const { data, error } = await supabase
        .from("trades")
        .select(
          "id, pair, side, entry_price, exit_price, size, realized_pnl, fees_usd, opened_at, closed_at, strategy_id",
        )
        .eq("user_id", userId!)
        .order("closed_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      const ids = [...new Set((data ?? []).map((row) => row.strategy_id).filter(Boolean))] as string[];
      const names = new Map<string, string>();
      if (ids.length) {
        const catalog = await supabase.from("strategies").select("id, name").in("id", ids);
        if (catalog.error) throw catalog.error;
        for (const strategy of catalog.data ?? []) names.set(strategy.id, strategy.name);
      }
      return (data ?? []).map((r) => {
        const opened = r.opened_at ? Date.parse(r.opened_at as string) : 0;
        const closed = r.closed_at ? Date.parse(r.closed_at as string) : 0;
        const durSec = opened && closed ? Math.max(0, (closed - opened) / 1000) : 0;
        return {
          id: String(r.id),
          closedAt: (r.closed_at as string) ?? "",
          symbol: String(r.pair),
          leg: names.get(String(r.strategy_id ?? "")) ?? null,
          direction: (r.side as "long" | "short") ?? "long",
          size: Number(r.size ?? 0),
          entry: Number(r.entry_price ?? 0),
          exit: Number(r.exit_price ?? 0),
          pnl: Number(r.realized_pnl ?? 0),
          fees: Number(r.fees_usd ?? 0),
          exitReason: "—",
          durationSec: durSec,
        };
      });
    },
  });
}

export function TradeHistoryCard({ book }: { book: Book }) {
  const { user } = useAuth();
  const paper = usePaperHistory(book === "paper" ? user?.id : undefined, PAGE_SIZE);
  const live = useLiveHistory(book === "live" ? user?.id : undefined, PAGE_SIZE);
  const query = book === "paper" ? paper : live;
  const rows: ClosedTrade[] = query.data ?? [];

  const summary = useMemo(() => {
    const total = rows.length;
    const wins = rows.filter((r) => r.pnl > 0).length;
    const realized = rows.reduce((a, r) => a + r.pnl, 0);
    return { total, wins, winRate: total ? wins / total : 0, realized };
  }, [rows]);

  return (
    <section
      className="rounded-2xl border border-white/[0.05] bg-[color:var(--surface-2)]/40 p-4"
      data-testid="trade-history"
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[13px] font-bold uppercase tracking-[0.16em] text-white">
            Trade History
          </h3>
          {/* Ruling #7 STEP 3 — per-surface mode badge (color + label). */}
          <span
            data-testid={`book-badge-${book}`}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.16em]"
            style={{
              color: book === "live" ? "var(--onixus-teal)" : "var(--onixus-purple)",
              background: `color-mix(in oklab, ${book === "live" ? "var(--onixus-teal)" : "var(--onixus-purple)"} 14%, transparent)`,
              border: `1px solid color-mix(in oklab, ${book === "live" ? "var(--onixus-teal)" : "var(--onixus-purple)"} 40%, transparent)`,
            }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: book === "live" ? "var(--onixus-teal)" : "var(--onixus-purple)" }}
            />
            {book === "live" ? "LIVE" : "PAPER"}
          </span>
        </div>
        <SummaryRow
          trades={summary.total}
          winRate={summary.winRate}
          realized={summary.realized}
        />
      </div>

      {query.isLoading ? (
        <EmptyBar label="Loading trade history…" />
      ) : rows.length === 0 ? (
        <EmptyBar label={`No closed trades yet (${book})`} />
      ) : (
        <div className="max-h-[420px] overflow-auto rounded-lg border border-white/[0.04]">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 z-10 bg-[color:var(--surface-1)] text-[9.5px] uppercase tracking-[0.14em] text-white/45">
              <tr>
                <Th>Closed</Th>
                <Th>Symbol</Th>
                <Th>Strategy</Th>
                <Th>Dir</Th>
                <Th align="right">Size</Th>
                <Th align="right">Entry</Th>
                <Th align="right">Exit</Th>
                <Th align="right">PnL</Th>
                <Th align="right">Fees</Th>
                <Th>Exit</Th>
                <Th align="right">Held</Th>
                <Th>Share</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <TradeRow key={r.id} row={r} book={book} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <th
      className={`px-2 py-1.5 ${align === "right" ? "text-right" : "text-left"} font-semibold`}
    >
      {children}
    </th>
  );
}

function TradeRow({ row, book }: { row: ClosedTrade; book: Book }) {
  const dirColor =
    row.direction === "long" ? "var(--onixus-teal)" : "var(--onixus-red)";
  const pnlColor =
    row.pnl >= 0
      ? "var(--onixus-teal)"
      : "color-mix(in oklab, var(--onixus-red) 65%, #000)";
  const when = row.closedAt
    ? new Date(row.closedAt).toLocaleString(undefined, {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
  return (
    <tr className="border-t border-white/[0.04] hover:bg-white/[0.02]">
      <td className="px-2 py-1.5 whitespace-nowrap text-white/70">{when}</td>
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-2">
          <PairBadge symbol={row.symbol.replace("-", "/")} size={20} />
        </div>
      </td>
      <td className="px-2 py-1.5 uppercase tracking-[0.1em] text-white/70">
        {row.leg ?? "Unattributed"}
      </td>
      <td className="px-2 py-1.5">
        <span
          className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em]"
          style={{
            color: dirColor,
            background: `color-mix(in oklab, ${dirColor} 16%, transparent)`,
          }}
        >
          {row.direction}
        </span>
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-white/85">
        {fmtNum(row.size, 4)}
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-white/85">
        {fmtNum(row.entry, 4)}
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-white/85">
        {fmtNum(row.exit, 4)}
      </td>
      <td
        className="px-2 py-1.5 text-right font-mono tabular-nums font-semibold"
        style={{ color: pnlColor }}
      >
        {row.pnl >= 0 ? "+" : ""}
        {fmtUsd(row.pnl)}
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-white/55">
        {fmtUsd(row.fees)}
      </td>
      <td className="px-2 py-1.5 uppercase tracking-[0.1em] text-white/70">
        {row.exitReason}
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-white/70">
        {fmtDuration(row.durationSec)}
      </td>
      <td className="px-2 py-1.5">
        <button
          type="button"
          aria-label={`Share ${book} trade result for ${row.symbol}`}
          className="grid h-8 w-8 place-items-center rounded-full border border-white/10 text-white/55 transition hover:border-violet-400/50 hover:text-violet-200"
          onClick={() => void shareTrade({ symbol: row.symbol, direction: row.direction, entry: row.entry, exit: row.exit, book })
            .then((result) => toast.success(result === "copied" ? "Result copied" : "Share sheet opened"))
            .catch((error) => { if ((error as Error).name !== "AbortError") toast.error((error as Error).message); })}
        >
          <Share2 className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  );
}

function SummaryRow({
  trades,
  winRate,
  realized,
}: {
  trades: number;
  winRate: number;
  realized: number;
}) {
  const pnlColor =
    realized >= 0
      ? "var(--onixus-teal)"
      : "color-mix(in oklab, var(--onixus-red) 65%, #000)";
  return (
    <div className="flex items-baseline gap-4 text-[10.5px]">
      <SummaryChip label="Trades" value={String(trades)} />
      <SummaryChip label="Win rate" value={trades ? `${(winRate * 100).toFixed(1)}%` : "—"} />
      <SummaryChip
        label="Realized"
        value={`${realized >= 0 ? "+" : ""}${fmtUsd(realized)}`}
        color={pnlColor}
      />
    </div>
  );
}

function SummaryChip({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[9px] uppercase tracking-[0.14em] text-white/45">{label}</span>
      <span
        className="font-mono tabular-nums font-semibold"
        style={{ color: color ?? "rgba(255,255,255,0.9)" }}
      >
        {value}
      </span>
    </div>
  );
}

function EmptyBar({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-white/[0.06] bg-black/40 px-4 py-6 text-center text-[11px] text-white/50">
      {label}
    </div>
  );
}
