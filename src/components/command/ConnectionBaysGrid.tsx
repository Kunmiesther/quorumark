import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plug, AlertTriangle, Lock } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { usePortfolioTotals, type ExchangeSummary } from "@/hooks/usePortfolioTotals";
import { MAX_CONNECTIONS, RISK_CAPITAL_MAX_PER_CONNECTION } from "@/lib/risk-capital";
import { turtleByAnyKey } from "@/lib/turtles";
import { isSupportedVenue } from "@/lib/supported-exchanges";
import { BayControls } from "./BayControls";

const VENUE_LABELS: Record<string, string> = {
  btcc: "BTCC",
  bydfi: "BYDfi",
  apex_omni: "ApeX Omni",
};

/** Human venue label. Unknown venues render as the raw slug — never faked. */
function venueLabel(v: string): string {
  return VENUE_LABELS[v] ?? v.toUpperCase();
}

interface BayRow {
  connection: {
    id: string;
    exchange: string;
    display_name: string | null;
    status: string | null;
  } | null;
  summary: ExchangeSummary | null;
  riskAllocated: number;
  riskStatus: "confirmed" | "unconfirmed" | "none";
  turtleSlug: string | null;
}

/**
 * Six-bay grid. ALWAYS renders MAX_CONNECTIONS slots so users can see the
 * ceiling. Empty slots render as explicit "Empty Bay" cards — never as fake
 * connections. Missing balance data renders as "Unavailable" — never as $0.
 * Each bay is per-connection; balances are NOT summed into a combined pool.
 */
export function ConnectionBaysGrid() {
  const { user } = useAuth();
  const portfolio = usePortfolioTotals();

  const { data: connections = [] } = useQuery({
    queryKey: ["trade-bays-connections", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("exchange_connections")
        .select("id, exchange, display_name, status, created_at")
        .eq("user_id", user!.id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: riskSummary = [] } = useQuery({
    queryKey: ["trade-bays-risk", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_risk_capital_summary");
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: assignments = [] } = useQuery({
    queryKey: ["trade-bays-assignments", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_strategy")
        .select("connection_id, strategies(slug)")
        .eq("user_id", user!.id);
      if (error) throw error;
      return data ?? [];
    },
  });

  const rows = useMemo<BayRow[]>(() => {
    const byId = new Map<string, ExchangeSummary>();
    for (const e of portfolio.exchangeEntries) {
      // Summaries are indexed by venue label in the shared hook; re-index by
      // connection.id here by matching venue → connection. If multiple
      // connections share a venue we prefer the first that has no entry yet.
      // This keeps display-only aggregation deterministic without inventing data.
      const conn = connections.find(
        (c) => venueLabel(c.exchange) === e.venue && !byId.has(c.id),
      );
      if (conn) byId.set(conn.id, e);
    }

    const riskById = new Map(
      riskSummary.map((r) => [
        r.connection_id,
        { amount: Number(r.allocated) || 0, status: (r.status as BayRow["riskStatus"]) ?? "none" },
      ]),
    );

    const turtleByConn = new Map<string, string>();
    for (const a of assignments) {
      const slug = (a.strategies as { slug?: string } | null)?.slug;
      if (a.connection_id && slug) turtleByConn.set(a.connection_id, slug);
    }

    return connections.map((c) => ({
      connection: c,
      summary: byId.get(c.id) ?? null,
      riskAllocated: riskById.get(c.id)?.amount ?? 0,
      riskStatus: riskById.get(c.id)?.status ?? "none",
      turtleSlug: turtleByConn.get(c.id) ?? null,
    }));
  }, [connections, portfolio.exchangeEntries, riskSummary, assignments]);

  const emptyCount = Math.max(0, MAX_CONNECTIONS - rows.length);
  const armedCount = rows.length;

  return (
    <section>
      <div className="mb-2.5 flex items-baseline justify-between">
        <h2 className="font-display text-[11px] font-bold uppercase tracking-[0.24em] text-[color:var(--text-secondary)]">
          Connection Bays
        </h2>
        <span className="num text-[11px] text-[color:var(--text-secondary)]">
          {armedCount}/{MAX_CONNECTIONS} armed
        </span>
      </div>

      <ul className="grid grid-cols-1 gap-2.5">
        {rows.map((r, i) => (
          <li key={r.connection!.id}>
            <BayCard index={i} row={r} />
          </li>
        ))}
        {Array.from({ length: emptyCount }).map((_, i) => (
          <li key={`empty-${i}`}>
            <EmptyBay index={armedCount + i} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function BayCard({ index, row }: { index: number; row: BayRow }) {
  const conn = row.connection!;
  const turtle = row.turtleSlug ? turtleByAnyKey(row.turtleSlug) : null;
  const accent = turtle?.accent ?? "var(--intel-cyan)";
  const supported = isSupportedVenue(conn.exchange);
  const status = conn.status ?? "unknown";
  const isVerified = status === "verified";
  const isConnected = status === "connected";
  const isPaused = status === "paused";
  const isDisconnected = status === "disconnected" || status === "disabled";

  const pct = Math.min(
    100,
    Math.round((row.riskAllocated / RISK_CAPITAL_MAX_PER_CONNECTION) * 100),
  );

  const equityLine = (() => {
    if (!supported) return { value: "Unsupported venue", missing: true };
    if (row.summary?.ok) {
      return {
        value: `$${row.summary.total.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
        missing: false,
      };
    }
    if (row.summary && !row.summary.ok) {
      return { value: "Unavailable", missing: true };
    }
    if (isVerified || isConnected) return { value: "Loading…", missing: true };
    return { value: "Not yet fetched", missing: true };
  })();

  return (
    <div
      className="command-surface relative overflow-hidden p-3.5"
      style={
        {
          ["--edge-color" as string]: accent,
        } as React.CSSProperties
      }
    >
      {/* Edge accent bar tied to the assigned turtle */}
      <div
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: accent, boxShadow: `0 0 12px ${accent}66` }}
      />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-display text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--text-secondary)]">
              Bay {String(index + 1).padStart(2, "0")}
            </span>
            <StatusPill status={status} />
          </div>
          <p className="mt-1.5 truncate font-display text-[15px] font-semibold uppercase tracking-[0.04em]">
            {conn.display_name || venueLabel(conn.exchange)}
          </p>
          <p className="mt-0.5 truncate text-[10.5px] uppercase tracking-[0.18em] text-[color:var(--text-secondary)]">
            {venueLabel(conn.exchange)}
          </p>
        </div>

        <div className="shrink-0 text-right">
          <p className="font-display text-[9px] font-bold uppercase tracking-[0.22em] text-[color:var(--text-secondary)]">
            Equity
          </p>
          <p
            className={`num mt-1 font-display text-[16px] font-semibold leading-none ${
              equityLine.missing ? "text-[color:var(--text-secondary)]" : ""
            }`}
          >
            {equityLine.value}
          </p>
        </div>
      </div>

      {/* Turtle assignment + execution lock */}
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-[9px] font-bold uppercase tracking-[0.22em] text-[color:var(--text-secondary)]">
            Assigned Turtle
          </p>
          {turtle ? (
            <p className="mt-0.5 truncate font-display text-[12px] font-semibold uppercase tracking-[0.06em]">
              <span style={{ color: accent }}>{turtle.name}</span>
              <span className="text-[color:var(--text-secondary)]"> · {turtle.suit}</span>
            </p>
          ) : (
            <p className="mt-0.5 truncate text-[11px] text-[color:var(--text-secondary)]">
              Unassigned
            </p>
          )}
        </div>
        <div className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-[color:var(--warn-amber)]/40 bg-[color:var(--warn-amber)]/10 px-2 py-1 text-[9.5px] font-bold uppercase tracking-[0.16em] text-[color:var(--warn-amber)]">
          <Lock className="h-3 w-3" />
          Mainnet Locked
        </div>
      </div>

      {/* Risk capital allocation */}
      <div className="mt-3">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="font-display text-[9px] font-bold uppercase tracking-[0.22em] text-[color:var(--text-secondary)]">
            Risk Capital
          </span>
          <span className="num text-[11px] font-semibold">
            ${row.riskAllocated.toLocaleString()}
            <span className="text-[color:var(--text-secondary)]">
              {" "}/ ${RISK_CAPITAL_MAX_PER_CONNECTION}
            </span>
            {row.riskStatus === "unconfirmed" && (
              <span className="ml-1 text-[10px] text-[color:var(--warn-amber)]">· unconfirmed</span>
            )}
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${pct}%`,
              background: accent,
              boxShadow: `0 0 8px color-mix(in oklab, ${accent} 60%, transparent)`,
            }}
          />
        </div>
      </div>

      {(!supported || isPaused || isDisconnected) && (
        <div className="mt-3 flex items-center gap-1.5 text-[11px] text-[color:var(--warn-amber)]">
          <AlertTriangle className="h-3.5 w-3.5" />
          {!supported
            ? "This venue is no longer supported."
            : isPaused
              ? "Paused — no orders will be submitted."
              : "Disconnected — reconnect to arm this bay."}
        </div>
      )}

      {supported && !isDisconnected && (
        <BayControls
          connectionId={conn.id}
          connectionLabel={conn.display_name || venueLabel(conn.exchange)}
          status={status}
        />
      )}
    </div>
  );
}

function EmptyBay({ index }: { index: number }) {
  return (
    <Link
      to="/profile"
      className="block rounded-[14px] border border-dashed border-white/10 bg-white/[0.02] p-4 text-left transition hover:border-[color:var(--intel-cyan)]/40 hover:bg-white/[0.03]"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--text-secondary)]">
            Bay {String(index + 1).padStart(2, "0")}
          </p>
          <p className="mt-1 font-display text-[14px] font-semibold uppercase tracking-[0.06em] text-[color:var(--text-secondary)]">
            Empty Bay
          </p>
          <p className="mt-1 text-[11px] text-[color:var(--text-secondary)]">
            Connect an exchange from your profile to arm this bay.
          </p>
        </div>
        <div className="shrink-0 flex h-9 w-9 items-center justify-center rounded-lg bg-white/[0.04] text-[color:var(--text-secondary)]">
          <Plug className="h-4 w-4" />
        </div>
      </div>
    </Link>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; color: string }> = {
    verified: { label: "Verified", color: "var(--verified)" },
    connected: { label: "Connected", color: "var(--intel-cyan)" },
    pending: { label: "Pending", color: "var(--warn-amber)" },
    paused: { label: "Paused", color: "var(--warn-amber)" },
    disconnected: { label: "Disconnected", color: "var(--text-secondary)" },
    disabled: { label: "Disabled", color: "var(--text-secondary)" },
  };
  const s = map[status] ?? { label: status, color: "var(--text-secondary)" };
  return (
    <span
      className="rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.18em]"
      style={{
        color: s.color,
        background: `color-mix(in oklab, ${s.color} 12%, transparent)`,
        border: `1px solid color-mix(in oklab, ${s.color} 32%, transparent)`,
      }}
    >
      {s.label}
    </span>
  );
}
