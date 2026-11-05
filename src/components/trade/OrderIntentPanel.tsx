import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

type Book = "paper" | "live";

type IntentRow = {
  id: string;
  symbol: string;
  side: string;
  state: string;
  venue: string;
  orderType: string;
  size: number | null;
  filled: number | null;
  price: number | null;
  updatedAt: string;
};

const ACTIVE_STATES = new Set([
  "previewed",
  "confirmed",
  "queued",
  "signing",
  "submitted",
  "open",
  "partially_filled",
  "cancellation_pending",
  "created",
  "pending",
]);

const ERROR_STATES = new Set(["rejected", "reconciliation_required", "failed"]);
const DONE_STATES = new Set(["filled", "cancelled", "executed", "closed"]);

function asNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stateLabel(state: string): string {
  return state.replaceAll("_", " ");
}

function ageLabel(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - t) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function tone(state: string): string {
  if (ERROR_STATES.has(state)) {
    return "border-[color:var(--onixus-red)]/35 bg-[color:var(--onixus-red)]/10 text-[color:var(--onixus-red)]";
  }
  if (DONE_STATES.has(state)) {
    return "border-white/10 bg-white/[0.05] text-white/55";
  }
  return "border-[color:var(--onixus-teal)]/35 bg-[color:var(--onixus-teal)]/10 text-[color:var(--onixus-teal)]";
}

function readErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown database read error";
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 220);
}

export function OrderIntentPanel({ book }: { book: Book }) {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ["order-intent-panel", book, user?.id],
    enabled: Boolean(user?.id),
    refetchInterval: 10_000,
    queryFn: async (): Promise<IntentRow[]> => {
      if (book === "paper") {
        const { data, error } = await supabase
          .from("paper_order_intents")
          .select("id, symbol, side, state, strategy, notional, margin, updated_at")
          .eq("user_id", user!.id)
          .order("updated_at", { ascending: false })
          .limit(20);
        if (error) throw error;
        return (data ?? []).map((row) => ({
          id: row.id,
          symbol: row.symbol,
          side: row.side,
          state: row.state,
          venue: "Paper engine",
          orderType: row.strategy ?? "strategy",
          size: asNumber(row.notional),
          filled: null,
          price: null,
          updatedAt: row.updated_at,
        }));
      }

      const { data, error } = await supabase
        .from("order_intents")
        .select(
          "id, symbol, side, state, venue, order_type, size, filled_size, avg_fill_price, updated_at",
        )
        .eq("user_id", user!.id)
        .eq("environment", "mainnet")
        .order("updated_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []).map((row) => ({
        id: row.id,
        symbol: row.symbol,
        side: row.side,
        state: row.state,
        venue: row.venue,
        orderType: row.order_type,
        size: asNumber(row.size),
        filled: asNumber(row.filled_size),
        price: asNumber(row.avg_fill_price),
        updatedAt: row.updated_at,
      }));
    },
  });

  const rows = useMemo(() => {
    const source = query.data ?? [];
    return [...source]
      .sort((a, b) => Number(ACTIVE_STATES.has(b.state)) - Number(ACTIVE_STATES.has(a.state)))
      .slice(0, 12);
  }, [query.data]);
  const active = rows.filter((row) => ACTIVE_STATES.has(row.state)).length;
  const attention = rows.filter((row) => ERROR_STATES.has(row.state)).length;

  return (
    <section data-testid={`order-intent-panel-${book}`}>
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/50">
            Order lifecycle
          </p>
          <p className="mt-0.5 text-[10.5px] text-white/40">
            Intent → signer → venue → fill. Refreshes every 10 seconds.
          </p>
        </div>
        <div className="flex gap-2 font-mono text-[9.5px] uppercase tracking-[0.12em]">
          <span className="rounded-md border border-[color:var(--onixus-teal)]/25 bg-[color:var(--onixus-teal)]/10 px-2 py-1 text-[color:var(--onixus-teal)]">
            {active} active
          </span>
          {attention > 0 ? (
            <span className="rounded-md border border-[color:var(--onixus-red)]/25 bg-[color:var(--onixus-red)]/10 px-2 py-1 text-[color:var(--onixus-red)]">
              {attention} attention
            </span>
          ) : null}
        </div>
      </header>

      {query.isLoading ? (
        <p className="rounded-xl bg-black/20 px-3 py-5 text-center text-xs text-white/40">
          Loading order activity…
        </p>
      ) : query.isError ? (
        <div className="rounded-xl border border-[color:var(--onixus-red)]/30 bg-[color:var(--onixus-red)]/10 px-3 py-3 text-xs text-[color:var(--onixus-red)]">
          <p className="font-semibold">
            Order lifecycle could not be read. Trading controls remain unchanged.
          </p>
          <p className="mt-1 break-words font-mono text-[9px] opacity-75">
            {readErrorMessage(query.error)}
          </p>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="mt-2 rounded-lg border border-current/25 px-2 py-1 text-[10px] font-semibold hover:bg-white/[0.04]"
          >
            Retry read
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-xl bg-black/20 px-3 py-5 text-center text-xs text-white/40">
          No order intents recorded for this {book} book.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
          <table className="w-full min-w-[660px] text-[10.5px]">
            <thead className="bg-black/25 text-[9px] uppercase tracking-[0.14em] text-white/40">
              <tr>
                <th className="px-3 py-2 text-left">Market</th>
                <th className="px-3 py-2 text-left">Route</th>
                <th className="px-3 py-2 text-right">Requested / filled</th>
                <th className="px-3 py-2 text-right">Avg fill</th>
                <th className="px-3 py-2 text-right">State</th>
                <th className="px-3 py-2 text-right">Age</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-white/[0.05] text-white/75">
                  <td className="px-3 py-2.5">
                    <span className="font-semibold text-white">{row.symbol}</span>
                    <span
                      className="ml-2 uppercase"
                      style={{
                        color:
                          row.side.toLowerCase().includes("buy") ||
                          row.side.toLowerCase().includes("long")
                            ? "var(--onixus-teal)"
                            : "var(--onixus-red)",
                      }}
                    >
                      {row.side}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div>{row.venue}</div>
                    <div className="mt-0.5 uppercase text-white/35">{row.orderType}</div>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                    {row.size == null
                      ? "—"
                      : row.size.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                    <span className="text-white/35"> / </span>
                    {row.filled == null
                      ? "—"
                      : row.filled.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                    {row.price == null
                      ? "—"
                      : row.price.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <span
                      className={cn(
                        "inline-flex rounded-md border px-2 py-1 text-[9px] font-bold uppercase tracking-[0.1em]",
                        tone(row.state),
                      )}
                    >
                      {stateLabel(row.state)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-white/40">
                    {ageLabel(row.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
