import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  BrainCircuit,
  ExternalLink,
  Power,
  Radio,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/hooks/useAuth";
import { useBotEvents, type BotEvent } from "@/hooks/useBotEvents";
import { useBotHealth } from "@/hooks/useBotHealth";
import { useExecutionStatus } from "@/hooks/useExecutionStatus";
import { useShortlistCycle } from "@/hooks/useShortlistCycle";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { verifiedAutomationVenue } from "@/lib/automation/liveVenueReadiness";
import { ExchangeIdentity } from "@/components/exchanges/ConnectionIdentity";
import { PairBadge } from "@/components/trade/PairBadge";
import { useCouncilReviews } from "@/hooks/useCouncilReviews";
import { liveLeverageMaximum, validLiveLeverage } from "@/lib/automation/liveLeverage";

type Book = "paper" | "live";
type StrategyMode = "paper" | "live";

const LIVE_CONFIRMATION = "ARM LIVE AUTOMATION";

type StrategyRow = {
  symbol: string;
  enabled: boolean;
  mode: string;
  market_type: string;
  cross_margin: boolean;
  margin_mode: string;
  strategy_id: string;
  connection_id: string | null;
  params: unknown;
  strategies: { slug: string; suit_name: string } | null;
  exchange_connections: {
    exchange: string;
    status: string;
    permission_trade: boolean;
    permissions_verified: boolean;
  } | null;
};

function isTradingStrategy(row: StrategyRow): boolean {
  return row.strategies?.slug !== "ema-cross";
}

function hasVerifiedLiveRoute(row: StrategyRow): boolean {
  return verifiedAutomationVenue(row.exchange_connections);
}

function distinctStrategyCount(rows: StrategyRow[]): number {
  const turtles = new Set<string>();
  for (const row of rows.filter(isTradingStrategy)) {
    const enabled = objectParam(row.params).enabled_turtles;
    if (Array.isArray(enabled)) {
      for (const turtle of enabled) if (typeof turtle === "string") turtles.add(turtle);
    } else if (row.strategies?.slug) {
      turtles.add(row.strategies.slug);
    }
  }
  return turtles.size;
}

function age(iso: string | null | undefined): string {
  if (!iso) return "never";
  const stamp = new Date(iso).getTime();
  if (!Number.isFinite(stamp)) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - stamp) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function objectParam(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function detailText(detail: Record<string, unknown> | null): string {
  if (!detail) return "No additional detail";
  const preferred = detail.reason ?? detail.message ?? detail.status ?? detail.symbol;
  if (typeof preferred === "string" && preferred.trim()) return preferred;

  const displayValue = (value: unknown): string => {
    if (value === null) return "null";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
      const serialized = JSON.stringify(value);
      if (!serialized) return "unavailable";
      return serialized.length > 160 ? `${serialized.slice(0, 157)}…` : serialized;
    } catch {
      return "unavailable";
    }
  };

  return Object.entries(detail)
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${displayValue(value)}`)
    .join(" · ");
}

function eventBook(event: BotEvent): Book | null {
  const detailMode = event.detail?.mode ?? event.detail?.book;
  if (detailMode === "paper" || detailMode === "live") return detailMode;
  const name = event.event.toLowerCase();
  if (name.includes("paper")) return "paper";
  if (name.includes("live")) return "live";
  return null;
}

export function AutomationOperationsPanel({ book }: { book: Book }) {
  const [liveIntent, setLiveIntent] = useState<StrategyRow | null>(null);
  const [liveConfirmation, setLiveConfirmation] = useState("");
  const [liveLeverage, setLiveLeverage] = useState("");
  function reviewLive(row: StrategyRow) {
    const saved = objectParam(row.params).leverage;
    setLiveLeverage(typeof saved === "number" && Number.isFinite(saved) ? String(saved) : "");
    setLiveIntent(row);
  }
  const [showAvailableForLive, setShowAvailableForLive] = useState(false);
  const { user } = useAuth();
  const client = useQueryClient();
  const execution = useExecutionStatus();
  const health = useBotHealth();
  const cycle = useShortlistCycle(book);
  const reviews = useCouncilReviews(book);
  const events = useBotEvents(12);
  const owner = useQuery({
    queryKey: ["automation-owner-access", user?.id],
    enabled: Boolean(user?.id),
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user!.id)
        .eq("role", "admin")
        .maybeSingle();
      if (error) throw error;
      return Boolean(data);
    },
  });
  const strategies = useQuery({
    queryKey: ["automation-strategy-config", user?.id],
    enabled: Boolean(user?.id),
    refetchInterval: 30_000,
    queryFn: async (): Promise<StrategyRow[]> => {
      const { data, error } = await supabase
        .from("user_strategy")
        .select(
          "symbol, enabled, mode, market_type, cross_margin, margin_mode, strategy_id, connection_id, params, strategies(slug, suit_name), exchange_connections(exchange,status,permission_trade,permissions_verified)",
        )
        .eq("user_id", user!.id)
        .order("symbol", { ascending: true });
      if (error) throw error;
      return (data ?? []) as StrategyRow[];
    },
  });

  const cycleRows = cycle.data?.rows ?? [];
  const selected = cycleRows.filter((row) => row.selected).length;
  const rejected = cycleRows.filter((row) => row.state === "rejected").length;
  const seats = cycleRows.flatMap((row) => row.seats);
  const availableSeats = seats.filter((seat) => seat.available).length;
  const latestReviews = book === "live" ? (reviews.data ?? []) : [];
  const reviewFailures = latestReviews.filter((review) => review.degraded);
  const aiLabel = latestReviews.length
    ? reviewFailures.length
      ? "Reviews degraded"
      : "Position reviews recorded"
    : seats.length
      ? `${availableSeats}/${seats.length} seats answered`
      : rejected > 0
        ? "Filtered before Council"
        : "No review recorded";
  const activeStrategies = useMemo(
    () => (strategies.data ?? []).filter((row) => row.enabled && isTradingStrategy(row)),
    [strategies.data],
  );
  const liveStrategies = useMemo(
    () => activeStrategies.filter((row) => row.mode === "live"),
    [activeStrategies],
  );
  const paperStrategies = useMemo(
    () => activeStrategies.filter((row) => row.mode !== "live"),
    [activeStrategies],
  );
  const rowsInView = useMemo(
    () => (strategies.data ?? []).filter((row) => row.mode === book),
    [book, strategies.data],
  );
  const availableForLive = useMemo(
    () => (strategies.data ?? []).filter((row) => isTradingStrategy(row) && row.mode !== "live"),
    [strategies.data],
  );
  const configuredTurtleCount = useMemo(() => distinctStrategyCount(rowsInView), [rowsInView]);
  const savedTurtleCount = useMemo(
    () => distinctStrategyCount(strategies.data ?? []),
    [strategies.data],
  );
  const liveTurtleCount = useMemo(() => distinctStrategyCount(liveStrategies), [liveStrategies]);
  const paperTurtleCount = useMemo(() => distinctStrategyCount(paperStrategies), [paperStrategies]);
  const visibleEvents = useMemo(
    () => (events.data ?? []).filter((event) => eventBook(event) === book).slice(0, 8),
    [book, events.data],
  );
  const executionValue = execution.isLoading
    ? "Checking…"
    : book === "live"
      ? execution.automationTradingReady
        ? "Live automation ready"
        : liveStrategies.length > 0
          ? "Live automation blocked"
          : execution.canArmLiveAutomation
            ? "Ready to arm"
            : "Live automation not armed"
      : paperStrategies.length > 0
        ? "Paper automation armed"
        : "Paper automation off";
  const executionDetail = execution.isLoading
    ? "Reading account and broker readiness."
    : book === "live"
      ? execution.automationTradingReady
        ? "Broker, signer, worker, and a live strategy row are ready."
        : liveStrategies.length > 0
          ? execution.runtimeReason
          : execution.canArmLiveAutomation
            ? "Broker, signer, worker, venue, and five-rung route are ready. Select a saved Live row to arm it."
            : `${execution.runtimeReason} No live strategy rows are armed; viewing this desk does not submit orders.`
      : paperStrategies.length > 0
        ? "Paper strategy rows are armed; their orders and results are simulated."
        : "No paper strategy rows are armed.";

  const control = useMutation({
    mutationFn: async ({
      row,
      mode,
      enabled,
      leverage,
    }: {
      row: StrategyRow;
      mode: StrategyMode;
      enabled: boolean;
      leverage?: number;
    }) => {
      if (!user) throw new Error("Sign in before changing strategy execution.");
      if (!owner.data) throw new Error("Owner access is required.");
      if (!row.connection_id) throw new Error("Assign a verified venue before changing execution.");
      if (
        mode === "live" &&
        enabled &&
        !validLiveLeverage(leverage ?? NaN, row.exchange_connections?.exchange)
      ) {
        throw new Error("Choose a valid leverage ceiling before arming this venue.");
      }
      if (mode === "live" && enabled && !execution.canArmLiveAutomation) {
        throw new Error(execution.runtimeReason || "Automated broker routing is not ready.");
      }
      if (mode === "live" && enabled && !hasVerifiedLiveRoute(row)) {
        throw new Error("This exchange does not have a verified live automation route.");
      }
      if (
        mode === "live" &&
        enabled &&
        execution.runtime?.automationVenues?.[row.exchange_connections?.exchange ?? ""] !== true
      ) {
        throw new Error("This exchange's automation broker and signer are not ready.");
      }

      const { data, error } = await supabase
        .from("user_strategy")
        .update({
          enabled,
          mode,
          updated_at: new Date().toISOString(),
          ...(mode === "live" && enabled
            ? { params: { ...objectParam(row.params), leverage } }
            : {}),
        })
        .eq("user_id", user.id)
        .eq("connection_id", row.connection_id)
        .eq("symbol", row.symbol)
        .eq("strategy_id", row.strategy_id)
        .eq("mode", row.mode)
        .eq("enabled", row.enabled)
        .filter(
          "params",
          row.params == null ? "is" : "eq",
          row.params == null ? null : JSON.stringify(row.params),
        )
        .select("symbol, enabled, mode")
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("Configuration changed. Refresh and review the strategy again.");

      const event = enabled
        ? mode === "live"
          ? "OWNER_LIVE_AUTOMATION_ARMED"
          : "OWNER_PAPER_AUTOMATION_ARMED"
        : "OWNER_AUTOMATION_PAUSED";
      const { error: auditError } = await supabase.from("bot_events").insert({
        user_id: user.id,
        level: mode === "live" && enabled ? "warning" : "info",
        event,
        detail: {
          symbol: row.symbol,
          strategy_id: row.strategy_id,
          connection_id: row.connection_id,
          enabled,
          mode,
          previous_enabled: row.enabled,
          previous_mode: row.mode,
          ...(mode === "live" && enabled ? { leverage } : {}),
          source: "automation_owner_control",
        },
      });
      return { enabled, mode, auditWarning: auditError?.message ?? null };
    },
    onSuccess: async ({ enabled, mode, auditWarning }) => {
      await refresh();
      if (auditWarning) {
        toast.warning(`Strategy changed, but the audit event failed: ${auditWarning}`);
        return;
      }
      toast.success(
        enabled
          ? mode === "live"
            ? "Live automation armed."
            : "Paper automation armed."
          : "Strategy paused.",
      );
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not update strategy execution.");
    },
  });

  const pauseAll = useMutation({
    mutationFn: async (mode: Book) => {
      if (!user) throw new Error("Sign in before changing strategy execution.");
      if (!owner.data) throw new Error("Owner access is required.");
      const { error } = await supabase
        .from("user_strategy")
        .update({ enabled: false, updated_at: new Date().toISOString() })
        .eq("user_id", user.id)
        .eq("mode", mode);
      if (error) throw error;
      const { error: auditError } = await supabase.from("bot_events").insert({
        user_id: user.id,
        level: "warning",
        event: "OWNER_AUTOMATION_MODE_PAUSED",
        detail: { source: "automation_owner_control", mode },
      });
      return { auditWarning: auditError?.message ?? null };
    },
    onSuccess: async ({ auditWarning }) => {
      await refresh();
      if (auditWarning) {
        toast.warning(`Strategies paused, but the audit event failed: ${auditWarning}`);
        return;
      }
      toast.success("Automated entries in this mode paused.");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not pause automation.");
    },
  });

  async function refresh(): Promise<void> {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["execution-runtime-health"] }),
      client.invalidateQueries({ queryKey: ["execution-status"] }),
      client.invalidateQueries({ queryKey: ["committee-shortlist", book] }),
      client.invalidateQueries({ queryKey: ["council-review-status"] }),
      client.invalidateQueries({ queryKey: ["bot-events"] }),
      client.invalidateQueries({ queryKey: ["automation-strategy-config"] }),
      client.invalidateQueries({ queryKey: ["worker-heartbeats"] }),
      client.invalidateQueries({ queryKey: ["user-strategy"] }),
      client.invalidateQueries({ queryKey: ["kill-switches-any"] }),
    ]);
  }

  return (
    <section
      id="automation-controls"
      className="tb-neu-panel mt-5 rounded-[24px] p-3 lg:p-4"
      data-testid="automation-operations-panel"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-violet-300/75">
            Operations monitor
          </p>
          <h2 className="mt-1 font-display text-lg">
            {book === "live" ? "Live automation status" : "Paper automation status"}
          </h2>
          <p className="mt-1 text-xs text-white/45">
            {book === "live"
              ? "Venue readiness, live Council cycle, strategy authority, and recorded live events."
              : "Simulated Council cycle, paper strategies, and recorded paper events."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-white/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/55">
            {book} cycle evidence
          </span>
          <button
            type="button"
            onClick={() => void refresh()}
            className="tb-neu-raised grid h-9 w-9 place-items-center rounded-full text-white/60 hover:text-white"
            aria-label="Refresh operations monitor"
          >
            <RefreshCw className={cn("h-4 w-4", cycle.isFetching && "animate-spin")} />
          </button>
        </div>
      </header>

      <AutomationAuthorityBanner
        book={book}
        loading={strategies.isLoading || execution.isLoading}
        savedCount={savedTurtleCount}
        activeCount={book === "live" ? liveTurtleCount : paperTurtleCount}
        liveCount={liveTurtleCount}
        automationReady={execution.automationTradingReady}
        reason={executionDetail}
      />

      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <TruthCard
          icon={<Radio className="h-4 w-4" />}
          label="Market worker"
          value={health.isLoading ? "Checking…" : health.worker.ready ? "Online" : "Offline"}
          detail={
            health.isLoading
              ? "Reading the production worker heartbeat."
              : health.worker.ready
                ? `Process health only · ${health.worker.workerId ?? "worker"} · heartbeat ${health.heartbeatAgeSec}s ago`
                : (health.worker.reason ?? "No fresh production heartbeat")
          }
          ok={health.worker.ready}
          pending={health.isLoading}
        />
        <TruthCard
          icon={<ShieldCheck className="h-4 w-4" />}
          label="Execution"
          value={executionValue}
          detail={executionDetail}
          ok={book === "live" ? execution.automationTradingReady : paperStrategies.length > 0}
          warning={
            book === "live" && execution.manualTradingReady && !execution.automationTradingReady
          }
          pending={execution.isLoading}
        />
        <TruthCard
          icon={<Activity className="h-4 w-4" />}
          label={`${book} entry scan`}
          value={
            cycle.isLoading
              ? "Loading…"
              : cycle.isError
                ? "Read failed"
                : (cycle.data?.status ?? "No entry scan recorded")
          }
          detail={
            cycle.isLoading
              ? "Reading the latest persisted Council cycle."
              : cycle.isError
                ? String(
                    cycle.error instanceof Error ? cycle.error.message : "Council data unavailable",
                  )
                : `${cycle.data?.candidateCount ?? 0}/${cycle.data?.universeSize ?? 0} candidates · ${selected} selected · ${rejected} rejected`
          }
          ok={Boolean(cycle.data?.status) && !cycle.isError}
          pending={cycle.isLoading}
        />
        <TruthCard
          icon={<BrainCircuit className="h-4 w-4" />}
          label="AI Council"
          value={
            cycle.isError || (book === "live" && reviews.isError)
              ? "Council status read failed"
              : cycle.isLoading || (book === "live" && reviews.isLoading)
                ? "Loading…"
                : !latestReviews.length && !cycle.data?.status && configuredTurtleCount === 0
                  ? "No strategy"
                  : aiLabel
          }
          detail={
            cycle.isError || (book === "live" && reviews.isError)
              ? "Could not read Council evidence. Refresh to retry; this is not proof that Council was not called."
              : latestReviews.length
                ? `${latestReviews.length} position reviews · latest ${age(latestReviews[0].created_at)}. ${reviewFailures[0]?.rationale ?? latestReviews[0].rationale ?? "Review recorded; see the decision stream for details."}`
                : cycle.isLoading
                  ? "Reading AI seat participation for the latest cycle."
                  : !cycle.data?.status && configuredTurtleCount === 0
                    ? "No strategy row exists, so there is nothing for the Council to evaluate."
                    : rejected > 0 && seats.length === 0
                      ? `No candidate reached Council. Reasons: ${[...new Set(cycleRows.map((row) => row.rejectionReason).filter(Boolean))].join(", ") || cycle.data?.noTradeReason || "no qualified candidates"}.`
                      : "No Council response is recorded for this view yet. Advisory evidence only; entry scans and open-position reviews are separate processes."
          }
          ok={reviewFailures.length === 0 && (latestReviews.length > 0 || availableSeats > 0)}
          warning={!cycle.isLoading && (reviewFailures.length > 0 || seats.length === 0)}
          pending={cycle.isLoading}
        />
      </div>

      {reviewFailures.length > 0 && (
        <details className="tb-neu-inset mt-3 rounded-xl p-3 text-xs text-amber-100">
          <summary className="cursor-pointer">
            Council response problems · {reviewFailures.length} position reviews
          </summary>
          {reviewFailures.map((review) => (
            <div key={review.position_id} className="mt-2 border-t border-white/10 pt-2">
              <p>{review.rationale}</p>
              {Array.isArray(review.council_opinions) &&
                review.council_opinions.map((raw, index) => {
                  const opinion = objectParam(raw);
                  return opinion.available === false ? (
                    <p key={index} className="mt-1 text-[11px]">
                      {String(opinion.role ?? "Seat")}: {String(opinion.reason ?? "unavailable")}
                      {String(opinion.reason ?? "").includes("402")
                        ? " — provider account/credit action required"
                        : ""}
                    </p>
                  ) : null;
                })}
            </div>
          ))}
        </details>
      )}
      <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,.85fr)]">
        <div className="tb-neu-inset min-w-0 rounded-2xl p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/45">
                {book === "live" ? "Live strategy rows" : "Simulation strategy rows"}
              </p>
              <p className="mt-1 text-[10px] text-white/35">
                {book === "live" ? liveTurtleCount : paperTurtleCount} active trading Turtles ·{" "}
                {rowsInView.length} symbol rows in this view
              </p>
            </div>
            <div className="flex items-center gap-2">
              {owner.data && (book === "live" ? liveStrategies : paperStrategies).length > 0 ? (
                <button
                  type="button"
                  disabled={pauseAll.isPending}
                  onClick={() => pauseAll.mutate(book)}
                  className="rounded-lg border border-rose-300/20 bg-rose-300/[0.06] px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.1em] text-rose-200 disabled:opacity-45"
                >
                  Pause all {book}
                </button>
              ) : null}
              <Link
                to="/trade"
                className="flex items-center gap-1 text-[10px] text-violet-200 hover:text-white"
              >
                Open trade desk <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          </div>
          {strategies.isLoading ? (
            <p className="py-5 text-center text-xs text-white/35">Loading strategy rows…</p>
          ) : strategies.isError ? (
            <ReadError
              label="Strategy configuration"
              error={strategies.error}
              onRetry={() => void strategies.refetch()}
            />
          ) : rowsInView.length === 0 ? (
            <div className="py-5 text-center text-xs text-white/35">
              <p>No {book} strategy rows configured.</p>
              {book === "live" && availableForLive.length > 0 && owner.data ? (
                <div className="mt-4 text-left">
                  <div className="rounded-2xl border border-violet-300/20 bg-violet-300/[0.06] px-3 py-2.5">
                    <p className="font-semibold text-violet-100">Ready for Live review</p>
                    <p className="mt-1 text-[10px] leading-4 text-white/45">
                      These saved Simulation rows can be promoted one symbol at a time. Review does
                      not place an order; arming requires the owner confirmation phrase.
                    </p>
                  </div>
                  <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                    {availableForLive.map((row) => {
                      const routeReady = hasVerifiedLiveRoute(row);
                      return (
                        <li
                          key={`${row.symbol}:${row.strategy_id}`}
                          className="rounded-xl border border-white/10 p-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <span className="min-w-0">
                              <span className="block truncate font-semibold text-white">
                                <PairBadge symbol={row.symbol} size={20} />
                              </span>
                              <span className="mt-1 block text-[10px] text-white/40">
                                {row.strategies?.suit_name ?? "Trading Turtle"} ·{" "}
                                {row.exchange_connections?.exchange ?? "venue unassigned"}
                              </span>
                            </span>
                            <button
                              type="button"
                              disabled={control.isPending || !row.connection_id || !routeReady}
                              onClick={() => {
                                reviewLive(row);
                                setLiveConfirmation("");
                              }}
                              className="shrink-0 rounded-lg border border-rose-300/25 bg-rose-300/[0.06] px-2.5 py-1.5 text-[10px] font-semibold text-rose-200 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {routeReady ? "Review & arm" : "Route not ready"}
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : book === "paper" ? (
                <a href="#automation" className="mt-2 inline-block font-semibold text-violet-200">
                  Configure a Turtle below
                </a>
              ) : null}
            </div>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[790px] text-[10.5px]">
                <thead className="text-[9px] uppercase tracking-[0.14em] text-white/35">
                  <tr>
                    <th className="pb-2 text-left">Symbol</th>
                    <th className="pb-2 text-left">Mode</th>
                    <th className="pb-2 text-left">Margin</th>
                    <th className="pb-2 text-right">Rungs</th>
                    <th className="pb-2 text-right">Connection</th>
                    <th className="pb-2 text-right">Owner control</th>
                  </tr>
                </thead>
                <tbody>
                  {rowsInView.map((row) => {
                    const params = objectParam(row.params);
                    const margin = params.margin_pct ?? params.margin_percent ?? params.margin;
                    const rungs = params.rung_count ?? params.rungs;
                    return (
                      <tr
                        key={`${row.symbol}:${row.strategy_id}`}
                        className="border-t border-white/[0.06]"
                      >
                        <td className="py-2 font-semibold text-white">
                          <PairBadge symbol={row.symbol} />
                        </td>
                        <td className="py-2 capitalize text-white/60">
                          <span
                            className={cn(
                              "rounded-full border px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.08em]",
                              row.enabled && row.mode === "live"
                                ? "border-rose-300/30 bg-rose-300/[0.08] text-rose-200"
                                : row.enabled
                                  ? "border-cyan-300/25 bg-cyan-300/[0.06] text-cyan-200"
                                  : "border-white/10 text-white/35",
                            )}
                          >
                            {row.enabled ? row.mode : "paused"}
                          </span>{" "}
                          · {row.market_type}
                        </td>
                        <td className="py-2 text-white/60">
                          {row.cross_margin ? "Cross" : row.margin_mode || "—"}
                          {margin != null ? ` · ${String(margin)}%` : ""}
                        </td>
                        <td className="py-2 text-right font-mono text-white/65">
                          {rungs == null ? "—" : String(rungs)}
                        </td>
                        <td className="py-2 text-right font-mono text-white/35">
                          <ExchangeIdentity
                            exchange={row.exchange_connections?.exchange ?? ""}
                            connectionId={row.connection_id}
                          />
                        </td>
                        <td className="py-2 text-right">
                          {!isTradingStrategy(row) ? (
                            <span className="text-cyan-200/70">Scout recon only</span>
                          ) : owner.isLoading ? (
                            <span className="text-white/30">Checking…</span>
                          ) : owner.data ? (
                            <div className="flex justify-end gap-1.5">
                              {book === "paper" ? (
                                <button
                                  type="button"
                                  disabled={control.isPending}
                                  onClick={() =>
                                    control.mutate({ row, mode: "paper", enabled: true })
                                  }
                                  className="rounded-lg border border-cyan-300/20 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-cyan-200 disabled:opacity-40"
                                >
                                  Resume simulation
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  disabled={control.isPending || !row.connection_id}
                                  onClick={() => {
                                    reviewLive(row);
                                    setLiveConfirmation("");
                                  }}
                                  className="rounded-lg border border-rose-300/25 bg-rose-300/[0.06] px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-rose-200 disabled:opacity-40"
                                >
                                  {row.enabled ? "Review Live" : "Arm Live"}
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={control.isPending || !row.enabled}
                                onClick={() =>
                                  control.mutate({
                                    row,
                                    mode: book,
                                    enabled: false,
                                  })
                                }
                                className="rounded-lg border border-white/10 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-white/45 disabled:opacity-40"
                              >
                                Pause
                              </button>
                            </div>
                          ) : (
                            <span className="text-white/30">Read only</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {book === "live" && availableForLive.length > 0 && owner.data ? (
            <div className="mt-3 border-t border-white/[0.06] pt-3">
              <button
                type="button"
                onClick={() => setShowAvailableForLive((open) => !open)}
                aria-expanded={showAvailableForLive}
                className="text-[10px] font-semibold text-violet-200 hover:text-white"
              >
                {showAvailableForLive
                  ? "Hide available strategies"
                  : "Choose a configured strategy for Live"}
              </button>
              {showAvailableForLive ? (
                <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                  {availableForLive.map((row) => (
                    <li
                      key={`${row.symbol}:${row.strategy_id}`}
                      className="flex items-center justify-between gap-3 rounded-xl border border-white/10 p-3 text-xs"
                    >
                      <span className="min-w-0 truncate">
                        <PairBadge symbol={row.symbol} size={20} /> ·{" "}
                        {row.strategies?.suit_name ?? "Trading Turtle"}
                      </span>
                      <button
                        type="button"
                        disabled={
                          control.isPending || !row.connection_id || !hasVerifiedLiveRoute(row)
                        }
                        onClick={() => {
                          reviewLive(row);
                          setLiveConfirmation("");
                        }}
                        className="shrink-0 rounded-lg border border-rose-300/25 px-2 py-1 text-[10px] font-semibold text-rose-200 disabled:opacity-40"
                      >
                        {hasVerifiedLiveRoute(row) ? "Review for Live" : "Route not ready"}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="tb-neu-inset min-w-0 rounded-2xl p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/45">
                Persisted activity
              </p>
              <p className="mt-1 text-[10px] text-white/35">Database events, newest first</p>
            </div>
            <span className="font-mono text-[9px] text-white/30">
              {age(visibleEvents[0]?.created_at)}
            </span>
          </div>
          {events.isLoading ? (
            <p className="py-5 text-center text-xs text-white/35">Loading events…</p>
          ) : events.isError ? (
            <ReadError
              label="Automation events"
              error={events.error}
              onRetry={() => void events.refetch()}
            />
          ) : visibleEvents.length === 0 ? (
            <p className="py-5 text-center text-xs text-white/35">
              No persisted {book} events yet.
            </p>
          ) : (
            <ul className="mt-3 max-h-56 space-y-1.5 overflow-y-auto pr-1">
              {visibleEvents.map((event) => (
                <li
                  key={event.id}
                  className="rounded-xl border border-white/[0.05] bg-black/15 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-mono text-[9.5px] uppercase tracking-[0.08em] text-white/65">
                      {event.event.replaceAll("_", " ")}
                    </span>
                    <span className="shrink-0 font-mono text-[8.5px] text-white/30">
                      {age(event.created_at)}
                    </span>
                  </div>
                  <p
                    className="mt-1 truncate text-[9.5px] text-white/35"
                    title={detailText(event.detail)}
                  >
                    {detailText(event.detail)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <Dialog
        open={Boolean(liveIntent)}
        onOpenChange={(open) => {
          if (!open && !control.isPending) {
            setLiveIntent(null);
            setLiveConfirmation("");
          }
        }}
      >
        <DialogContent className="max-w-md rounded-[24px] border-rose-300/20 bg-[#11121a]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-rose-300" />
              Arm live automation
            </DialogTitle>
            <DialogDescription className="leading-5">
              This gives the worker permission to submit real orders for the selected strategy row.
              It does not place an order immediately; the next qualified signal may.
            </DialogDescription>
          </DialogHeader>

          <div className="tb-neu-inset space-y-2 rounded-2xl p-3 text-xs">
            <OwnerReviewRow label="Symbol" value={liveIntent?.symbol ?? "—"} />
            <OwnerReviewRow
              label="Venue"
              value={
                liveIntent?.connection_id
                  ? `${liveIntent.connection_id.slice(0, 8)}…`
                  : "Unassigned"
              }
            />
            <OwnerReviewRow
              label="Margin"
              value={
                liveIntent?.margin_mode || (liveIntent?.cross_margin ? "cross" : "venue default")
              }
            />
            <OwnerReviewRow
              label="Runtime"
              value={
                execution.canArmLiveAutomation &&
                liveIntent &&
                hasVerifiedLiveRoute(liveIntent) &&
                execution.runtime?.automationVenues?.[
                  liveIntent.exchange_connections?.exchange ?? ""
                ] === true
                  ? "Automation broker and signer ready"
                  : "This strategy's exchange route is not ready. Verify its connection and runtime."
              }
            />
          </div>

          <label className="block text-xs text-white/70">
            Leverage ceiling (1–{liveLeverageMaximum(liveIntent?.exchange_connections?.exchange)}×)
            <input
              type="number"
              min="1"
              step="1"
              max={liveLeverageMaximum(liveIntent?.exchange_connections?.exchange)}
              value={liveLeverage}
              onChange={(event) => setLiveLeverage(event.target.value)}
              className="tb-neu-inset mt-2 w-full rounded-xl border border-white/10 bg-transparent px-3 py-2"
            />
            <span className="mt-2 block text-white/50">
              Saved with this symbol's live configuration. Exchange and symbol limits still apply.
            </span>
          </label>
          <label className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-white/50">
            Type {LIVE_CONFIRMATION}
            <input
              value={liveConfirmation}
              onChange={(event) => setLiveConfirmation(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="tb-neu-inset mt-2 w-full rounded-xl border border-white/[0.06] bg-transparent px-3 py-2 font-mono text-xs normal-case tracking-normal text-white outline-none focus:border-rose-300/35"
            />
          </label>

          <DialogFooter className="gap-2 sm:gap-2">
            <button
              type="button"
              disabled={control.isPending}
              onClick={() => {
                setLiveIntent(null);
                setLiveConfirmation("");
              }}
              className="rounded-xl border border-white/10 px-4 py-2 text-xs text-white/60"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={
                !liveIntent ||
                liveConfirmation.trim() !== LIVE_CONFIRMATION ||
                !validLiveLeverage(
                  Number(liveLeverage),
                  liveIntent?.exchange_connections?.exchange,
                ) ||
                !execution.canArmLiveAutomation ||
                !hasVerifiedLiveRoute(liveIntent) ||
                execution.runtime?.automationVenues?.[
                  liveIntent.exchange_connections?.exchange ?? ""
                ] !== true ||
                control.isPending
              }
              onClick={async () => {
                if (!liveIntent) return;
                try {
                  await control.mutateAsync({
                    row: liveIntent,
                    mode: "live",
                    enabled: true,
                    leverage: Number(liveLeverage),
                  });
                  setLiveIntent(null);
                  setLiveConfirmation("");
                } catch {
                  // The mutation renders the specific error and keeps the
                  // review open so the owner can correct the blocker.
                }
              }}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-rose-500 px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-35"
            >
              <Power className="h-4 w-4" />
              {control.isPending ? "Arming…" : "Arm live"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function AutomationAuthorityBanner({
  book,
  loading,
  savedCount,
  activeCount,
  liveCount,
  automationReady,
  reason,
}: {
  book: Book;
  loading: boolean;
  savedCount: number;
  activeCount: number;
  liveCount: number;
  automationReady: boolean;
  reason: string;
}) {
  const state = loading
    ? {
        label: "Checking automation authority",
        detail: "Reading the saved strategy rows and execution runtime.",
        className: "border-white/10 bg-white/[0.03] text-white/60",
      }
    : savedCount === 0
      ? {
          label: "Automation off — no strategy configured",
          detail:
            "The worker is healthy, but it has no saved strategy row and cannot submit automated orders.",
          className: "border-amber-300/25 bg-amber-300/[0.07] text-amber-100",
        }
      : book === "live" && liveCount > 0 && automationReady
        ? {
            label: `Live automation armed — ${liveCount} ${liveCount === 1 ? "strategy" : "strategies"}`,
            detail: reason,
            className: "border-emerald-300/25 bg-emerald-300/[0.07] text-emerald-100",
          }
        : book === "live" && liveCount > 0
          ? {
              label: "Live strategy configured — execution blocked",
              detail: reason,
              className: "border-rose-300/25 bg-rose-300/[0.07] text-rose-100",
            }
          : book === "live"
            ? {
                label: "Live automation not armed",
                detail:
                  "No live strategy rows are armed. Viewing this page does not enable trading; use the owner control for a specific symbol when ready.",
                className: "border-amber-300/25 bg-amber-300/[0.07] text-amber-100",
              }
            : activeCount > 0
              ? {
                  label: `Paper automation armed — ${activeCount} ${activeCount === 1 ? "Turtle" : "Turtles"}`,
                  detail: reason,
                  className: "border-cyan-300/25 bg-cyan-300/[0.07] text-cyan-100",
                }
              : {
                  label: "Paper automation off",
                  detail: reason,
                  className: "border-amber-300/25 bg-amber-300/[0.07] text-amber-100",
                };

  return (
    <div className={cn("mt-4 rounded-2xl border px-4 py-3", state.className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.14em]">{state.label}</p>
          <p className="mt-1 text-[10.5px] leading-4 text-white/55">{state.detail}</p>
        </div>
        {!loading && savedCount === 0 && book === "paper" ? (
          <a
            href="#automation"
            className="rounded-xl border border-current/20 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.1em]"
          >
            Configure a Turtle
          </a>
        ) : null}
      </div>
    </div>
  );
}

function OwnerReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/[0.05] pb-2 last:border-0 last:pb-0">
      <span className="text-white/40">{label}</span>
      <span className="max-w-[65%] text-right font-mono text-white/75">{value}</span>
    </div>
  );
}

function TruthCard({
  icon,
  label,
  value,
  detail,
  ok,
  warning = false,
  pending = false,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  ok: boolean;
  warning?: boolean;
  pending?: boolean;
}) {
  const color = pending
    ? "text-white/55"
    : ok
      ? "text-emerald-300"
      : warning
        ? "text-amber-200"
        : "text-rose-300";
  return (
    <article className="tb-neu-inset min-w-0 rounded-2xl p-3">
      <div className="flex items-center gap-2 text-white/45">
        {icon}
        <span className="truncate text-[9.5px] font-bold uppercase tracking-[0.15em]">{label}</span>
      </div>
      <p className={cn("mt-2 truncate text-sm font-semibold", color)}>{value}</p>
      <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-white/35" title={detail}>
        {detail}
      </p>
    </article>
  );
}

function ReadError({
  label,
  error,
  onRetry,
}: {
  label: string;
  error: unknown;
  onRetry: () => void;
}) {
  const message = error instanceof Error ? error.message : "Unknown read error";
  return (
    <div className="mt-3 rounded-xl border border-rose-300/20 bg-rose-300/[0.06] p-3 text-[10px] text-rose-200">
      <p className="font-semibold">{label} could not be read.</p>
      <p className="mt-1 break-words font-mono text-[9px] text-rose-200/70">
        {message.slice(0, 180)}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 rounded-lg border border-rose-200/20 px-2 py-1 font-semibold hover:bg-white/[0.04]"
      >
        Retry
      </button>
    </div>
  );
}
