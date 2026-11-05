import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, RefreshCw } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";

type Book = "live" | "paper";
type ClosedTrade = {
  id: string;
  connection_id: string | null;
  wallet_connection_id: string | null;
  autopilot_workflow_id: string | null;
  exchange: string;
  strategy_id: string | null;
  decision_id: string | null;
  pair: string;
  realized_pnl: number;
  closed_at: string;
};
type PaperTrade = { id: string; pnl_net: number; closed_at: string };
type LiveCouncilRow = {
  id: string;
  position_id: string;
  status: string;
  decision: string | null;
  rationale: string | null;
  reject_reason: string | null;
  created_at: string;
  venue_order_id: string | null;
};
type PaperCouncilRow = {
  id: string;
  symbol: string;
  direction: string;
  state: string;
  verdict: string | null;
  rejection_reason: string | null;
  created_at: string;
};
type AdvisoryRow = {
  id: string;
  position_id: string;
  symbol: string;
  consensus_action: string;
  narrative: string;
  advisory: boolean;
  created_at: string;
};
type Decision = {
  id: string;
  at: string;
  source: string;
  venue: string;
  symbol: string;
  decision: string;
  reason: string;
  evidence: string;
};

const money = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

function labelForStrategy(slug: string): string {
  return (
    (
      {
        dca: "Accumulator",
        "break-retest": "Vanguard",
        "rsi-divergence": "Sniper",
        "liq-hunting": "Hunter",
        "funding-arb": "Arbiter",
      } as Record<string, string>
    )[slug] ?? slug
  );
}

export function AutomationObservatory({ book }: { book: Book }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [venueFilter, setVenueFilter] = useState("all");
  const userId = user?.id;
  const since = useMemo(() => new Date(Date.now() - 30 * 86_400_000).toISOString(), []);

  const dataQ = useQuery({
    queryKey: ["automation-observatory", book, userId, since],
    enabled: Boolean(userId),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const [
        venuesR,
        strategiesR,
        tradesR,
        decisionsR,
        councilR,
        positionsR,
        advisoriesR,
        cyclesR,
      ] = await Promise.all([
        supabase
          .from("exchange_connections")
          .select("id,exchange,display_name")
          .eq("user_id", userId!),
        supabase.from("strategies").select("id,slug,suit_name"),
        book === "live"
          ? supabase
              .from("trades")
              .select(
                "id,connection_id,wallet_connection_id,autopilot_workflow_id,exchange,strategy_id,decision_id,pair,realized_pnl,closed_at",
              )
              .eq("user_id", userId!)
              .eq("book", "live")
              .eq("evidence_verified", true)
              .gte("closed_at", since)
              .order("closed_at", { ascending: false })
              .limit(1000)
          : supabase
              .from("paper_trades")
              .select("id,pnl_net,closed_at")
              .eq("user_id", userId!)
              .gte("closed_at", since)
              .order("closed_at", { ascending: false })
              .limit(1000),
        book === "live"
          ? supabase
              .from("strategy_decisions")
              .select(
                "decision_id,connection_id,symbol,strategy,direction,reason,reason_code,execution_state,created_at",
              )
              .eq("user_id", userId!)
              .order("created_at", { ascending: false })
              .limit(100)
          : supabase
              .from("strategy_decisions")
              .select(
                "decision_id,connection_id,symbol,strategy,direction,reason,reason_code,execution_state,created_at",
              )
              .eq("user_id", userId!)
              .eq("execution_state", "not_reached")
              .order("created_at", { ascending: false })
              .limit(100),
        book === "live"
          ? supabase
              .from("live_tp_council_reviews")
              .select(
                "id,position_id,status,decision,rationale,reject_reason,created_at,venue_order_id",
              )
              .eq("user_id", userId!)
              .order("created_at", { ascending: false })
              .limit(100)
          : supabase
              .from("committee_shortlist")
              .select("id,symbol,direction,state,verdict,rejection_reason,created_at")
              .eq("user_id", userId!)
              .order("created_at", { ascending: false })
              .limit(100),
        book === "live"
          ? supabase
              .from("positions")
              .select("id,connection_id,pair")
              .eq("user_id", userId!)
              .eq("source", "live")
              .limit(500)
          : Promise.resolve({ data: [], error: null }),
        book === "live"
          ? supabase
              .from("live_position_advisories")
              .select("id,position_id,symbol,consensus_action,narrative,advisory,created_at")
              .eq("user_id", userId!)
              .order("created_at", { ascending: false })
              .limit(100)
          : Promise.resolve({ data: [], error: null }),
        book === "live"
          ? supabase
              .from("committee_cycles")
              .select("id")
              .eq("user_id", userId!)
              .eq("book", "live")
              .order("created_at", { ascending: false })
              .limit(30)
          : Promise.resolve({ data: [], error: null }),
      ]);
      const error =
        venuesR.error ??
        strategiesR.error ??
        tradesR.error ??
        decisionsR.error ??
        councilR.error ??
        positionsR.error ??
        advisoriesR.error ??
        cyclesR.error;
      if (error) throw error;
      const liveCycleIds = (cyclesR.data ?? []).map((cycle) => cycle.id);
      const shortlistR =
        book === "live" && liveCycleIds.length
          ? await supabase
              .from("committee_shortlist")
              .select("id,symbol,direction,state,verdict,rejection_reason,created_at")
              .eq("user_id", userId!)
              .in("cycle_id", liveCycleIds)
              .order("created_at", { ascending: false })
              .limit(100)
          : { data: [] as PaperCouncilRow[], error: null };
      if (shortlistR.error) throw shortlistR.error;
      const venueById = new Map(
        (venuesR.data ?? []).map((venue) => [venue.id, venue.display_name || venue.exchange]),
      );
      const positionById = new Map(
        (positionsR.data ?? []).map((position) => [position.id, position]),
      );
      const strategyById = new Map(
        (strategiesR.data ?? []).map((strategy) => [strategy.id, labelForStrategy(strategy.slug)]),
      );
      const trades =
        book === "live"
          ? ((tradesR.data ?? []) as ClosedTrade[]).map((trade) => ({
              id: trade.id,
              pnl: Number(trade.realized_pnl),
              turtle: strategyById.get(trade.strategy_id ?? "") ?? "Unattributed strategy",
              venue:
                venueById.get(trade.connection_id ?? "") ??
                `${trade.exchange} · account unrecorded`,
            }))
          : ((tradesR.data ?? []) as unknown as PaperTrade[]).map((trade) => ({
              id: trade.id,
              pnl: Number(trade.pnl_net),
              turtle: "Turtle not recorded",
              venue: "Simulation",
            }));
      const decisions: Decision[] = (decisionsR.data ?? []).map((row) => ({
        id: `strategy:${row.decision_id}`,
        at: row.created_at,
        source: row.strategy || "Turtle",
        venue: venueById.get(row.connection_id) ?? "Unknown venue",
        symbol: row.symbol,
        decision: row.direction.toUpperCase(),
        reason: row.reason || row.reason_code,
        evidence: row.execution_state,
      }));
      if (book === "live") {
        for (const row of (councilR.data ?? []) as LiveCouncilRow[]) {
          const position = positionById.get(row.position_id);
          decisions.push({
            id: `council:${row.id}`,
            at: row.created_at,
            source: "Council / Onyx review",
            venue: venueById.get(position?.connection_id ?? "") ?? "Unknown venue",
            symbol: position?.pair ?? "Position unavailable",
            decision: row.decision || row.status,
            reason: row.rationale || row.reject_reason || "Review recorded",
            evidence: row.venue_order_id
              ? `Venue order ${row.venue_order_id}`
              : "No venue order in this review",
          });
        }
        for (const row of (advisoriesR.data ?? []) as AdvisoryRow[]) {
          const position = positionById.get(row.position_id);
          decisions.push({
            id: `onyx:${row.id}`,
            at: row.created_at,
            source: "Onyx position review",
            venue: venueById.get(position?.connection_id ?? "") ?? "Unknown venue",
            symbol: row.symbol,
            decision: row.consensus_action,
            reason: row.narrative || "Position review recorded",
            evidence: row.advisory
              ? "Advisory only"
              : "Action review; verify venue order separately",
          });
        }
        for (const row of (shortlistR.data ?? []) as PaperCouncilRow[]) {
          decisions.push({
            id: `shortlist:${row.id}`,
            at: row.created_at,
            source: "Council shortlist",
            venue: "Cross-venue review",
            symbol: row.symbol,
            decision: row.verdict || row.state,
            reason: row.rejection_reason || `${row.direction} candidate`,
            evidence: "Decision record; not an order",
          });
        }
      } else {
        for (const row of (councilR.data ?? []) as PaperCouncilRow[]) {
          decisions.push({
            id: `council:${row.id}`,
            at: row.created_at,
            source: "Council shortlist",
            venue: "Simulation",
            symbol: row.symbol,
            decision: row.verdict || row.state,
            reason: row.rejection_reason || `${row.direction} candidate`,
            evidence: "Simulated decision",
          });
        }
      }
      decisions.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      return {
        trades,
        decisions,
        venues: [...new Set(decisions.map((row) => row.venue))],
        truncated: trades.length === 1000,
      };
    },
  });

  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`automation-observatory-${book}-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "strategy_decisions",
          filter: `user_id=eq.${userId}`,
        },
        () => {
          void queryClient.invalidateQueries({
            queryKey: ["automation-observatory", book, userId],
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: book === "live" ? "live_tp_council_reviews" : "committee_shortlist",
          filter: `user_id=eq.${userId}`,
        },
        () => {
          void queryClient.invalidateQueries({
            queryKey: ["automation-observatory", book, userId],
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "committee_shortlist",
          filter: `user_id=eq.${userId}`,
        },
        () => {
          void queryClient.invalidateQueries({
            queryKey: ["automation-observatory", book, userId],
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "live_position_advisories",
          filter: `user_id=eq.${userId}`,
        },
        () => {
          void queryClient.invalidateQueries({
            queryKey: ["automation-observatory", book, userId],
          });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [book, queryClient, userId]);

  const trades = dataQ.data?.trades ?? [];
  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl < 0);
  const profit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const loss = losses.reduce((sum, trade) => sum + trade.pnl, 0);
  const scored = wins.length + losses.length;
  const turtles = [...new Set(trades.map((trade) => trade.turtle))].map((name) => {
    const rows = trades.filter((trade) => trade.turtle === name);
    const decided = rows.filter((trade) => trade.pnl !== 0);
    return {
      name,
      closes: rows.length,
      winRate: decided.length
        ? Math.round((100 * rows.filter((trade) => trade.pnl > 0).length) / decided.length)
        : null,
      net: rows.reduce((sum, trade) => sum + trade.pnl, 0),
    };
  });
  const visible = (dataQ.data?.decisions ?? [])
    .filter((row) => venueFilter === "all" || row.venue === venueFilter)
    .slice(0, 60);

  return (
    <section
      className="tb-neu-panel mt-5 min-w-0 rounded-[28px] p-4 lg:p-5"
      aria-labelledby="automation-results-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-300/75">
            {book === "live" ? "Live evidence" : "Simulation evidence"}
          </p>
          <h2 id="automation-results-heading" className="mt-1 font-display text-xl">
            Automation results & decisions
          </h2>
          <p className="mt-1 text-xs leading-5 text-white/45">
            Last 30 days ·{" "}
            {book === "live"
              ? "exchange-confirmed account closes across connected venues"
              : "simulated closes"}{" "}
            · refreshed every 15 seconds
          </p>
        </div>
        <button
          type="button"
          onClick={() => void dataQ.refetch()}
          aria-label="Refresh automation evidence"
          className="tb-neu-raised grid h-10 w-10 place-items-center rounded-full text-white/65"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>
      {dataQ.isError ? (
        <p role="alert" className="mt-4 text-sm text-rose-200">
          Results could not be verified. No values are being estimated.
        </p>
      ) : null}
      {dataQ.isLoading ? (
        <p className="mt-4 text-sm text-white/45">Reading verified trade and decision records…</p>
      ) : null}
      {dataQ.isSuccess ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-5">
            <Metric label="Closed trades" value={String(trades.length)} />
            <Metric
              label="Win rate"
              value={scored ? `${Math.round((100 * wins.length) / scored)}%` : "—"}
            />
            <Metric label="Winning-trade P&L" value={money(profit)} />
            <Metric label="Losing-trade P&L" value={money(loss)} />
            <Metric label="Net P&L" value={money(profit + loss)} />
          </div>
          {dataQ.data.truncated ? (
            <p className="mt-2 text-xs text-amber-200">
              Showing the latest 1,000 closes only; results are not an all-time total.
            </p>
          ) : null}
          <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
            <div className="tb-neu-inset min-w-0 rounded-2xl p-3">
              <h3 className="text-sm font-semibold">Turtle performance</h3>
              {book === "paper" ? (
                <p className="mt-3 text-xs leading-5 text-white/45">
                  Turtle-level win rates are unavailable for simulation: closed simulation records
                  do not persist a Turtle ID. The aggregate figures above are recorded; attribution
                  is not being guessed.
                </p>
              ) : turtles.filter((turtle) => turtle.name !== "Unattributed strategy").length ? (
                <div className="mt-2 space-y-2">
                  {turtles
                    .filter((turtle) => turtle.name !== "Unattributed strategy")
                    .map((turtle) => (
                      <div
                        key={turtle.name}
                        className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 rounded-xl bg-white/[0.03] px-3 py-2 text-xs"
                      >
                        <span className="truncate">{turtle.name}</span>
                        <span>{turtle.winRate === null ? "—" : `${turtle.winRate}%`} wins</span>
                        <span className={turtle.net < 0 ? "text-rose-200" : "text-emerald-200"}>
                          {money(turtle.net)}
                        </span>
                      </div>
                    ))}
                </div>
              ) : (
                <p className="mt-3 text-xs leading-5 text-white/45">
                  No strategy-attributed live closes were recorded in this period. Account totals
                  above may include manual or older unattributed trades.
                </p>
              )}
            </div>
            <div className="tb-neu-inset min-w-0 rounded-2xl p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <Activity className="h-4 w-4 text-cyan-300" /> Decision stream
                </h3>
                <select
                  aria-label="Filter decisions by exchange"
                  value={venueFilter}
                  onChange={(event) => setVenueFilter(event.target.value)}
                  className="max-w-full rounded-xl border border-white/10 bg-[#14151e] px-2 py-1.5 text-xs"
                >
                  <option value="all">All exchanges</option>
                  {dataQ.data.venues.map((venue) => (
                    <option key={venue} value={venue}>
                      {venue}
                    </option>
                  ))}
                </select>
              </div>
              <div className="mt-2 max-h-96 space-y-2 overflow-y-auto" aria-live="polite">
                {visible.length ? (
                  visible.map((row) => (
                    <article
                      key={row.id}
                      className="min-w-0 rounded-xl border border-white/[0.05] bg-white/[0.025] p-3"
                    >
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <span className="font-semibold text-white">{row.symbol}</span>
                        <span className="text-cyan-200">{row.decision}</span>
                        <span className="text-white/50">
                          {row.source} · {row.venue}
                        </span>
                        <time className="ml-auto text-white/35" dateTime={row.at}>
                          {new Date(row.at).toLocaleTimeString()}
                        </time>
                      </div>
                      <p className="mt-1 break-words text-xs leading-5 text-white/60">
                        {row.reason}
                      </p>
                      <p className="mt-1 break-all text-[10px] text-white/30">{row.evidence}</p>
                    </article>
                  ))
                ) : (
                  <p className="py-5 text-center text-xs text-white/40">
                    No recorded decisions for this view yet.
                  </p>
                )}
              </div>
            </div>
          </div>
          <p className="mt-3 text-[11px] leading-5 text-white/35">
            This stream combines persisted Turtle, Council, and Onyx review decisions. Realtime
            delivery is backed up by 15-second refresh; a missing record is not invented. Live
            P&amp;L is account-wide, not automation-only: older closes may lack a venue connection
            or automation attribution. Current reconciled fills retain wallet, workflow, strategy,
            and decision IDs when those links exist; older records remain explicitly unattributed.
          </p>
        </>
      ) : null}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="tb-neu-inset min-w-0 rounded-2xl p-3">
      <p className="text-[10px] uppercase tracking-[0.12em] text-white/40">{label}</p>
      <p className="mt-2 break-words font-mono text-base text-white">{value}</p>
    </div>
  );
}
