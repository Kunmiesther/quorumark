import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowUpRight, ShieldAlert } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { tpOrderEvidence } from "@/lib/live/venueOrderEvidence";
import { readPositionProtection } from "@/lib/live/positionProtection";
import { PositionProtectionReadout } from "@/components/trade/PositionProtectionReadout";
import { PositionSymbolFilters } from "./PositionSymbolFilters";
import { ExchangeIdentity, WalletIdentity } from "@/components/exchanges/ConnectionIdentity";
import { exchangeWalletIdentitiesQuery } from "@/hooks/exchangeWalletIdentities";
import { connectedWallets } from "@/lib/wallet/accountIdentity";

const SYMBOLS = ["BTC", "ETH", "SOL", "XRP"] as const;
const REFRESH_MS = 15_000;

type LivePosition = {
  id: string;
  connection_id: string | null;
  wallet_connection_id: string | null;
  autopilot_workflow_id: string | null;
  strategy_id: string | null;
  decision_id: string | null;
  exchange: string;
  pair: string;
  side: string;
  size: number;
  entry_price: number;
  mark_price: number | null;
  unrealized_pnl: number | null;
  leverage: number | null;
  synced_at: string | null;
  open_orders: unknown;
  tp_state: string;
  tp_venue_order_id: string | null;
  tp_execution_timeframe: string | null;
  tp_last_decision: string | null;
  tp_last_reviewed_at: string | null;
  strategy_metadata: Record<string, unknown> | null;
};

type VenueConnection = { id: string; exchange: string; display_name: string | null };
type WalletConnection = {
  id: string;
  provider: string;
  assigned_exchange_connection_id: string | null;
  label: string | null;
  public_address: string;
  status: string;
};

type LiveReview = {
  position_id: string;
  review_seq: number;
  status: string;
  decision: string | null;
  rationale: string | null;
  reject_reason: string | null;
  degraded: boolean;
  completed_at: string | null;
  venue_order_id: string | null;
  council_inputs: Record<string, unknown> | null;
  council_opinions: unknown;
};

type OpinionSummary = { role: string; decision: string; market_state: string | null };

function opinionSummaries(value: unknown): OpinionSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((opinion) => {
    if (!opinion || typeof opinion !== "object") return [];
    const data = opinion as Record<string, unknown>;
    if (
      data.available !== true ||
      typeof data.role !== "string" ||
      typeof data.decision !== "string"
    )
      return [];
    return [
      {
        role: data.role,
        decision: data.decision,
        market_state: typeof data.market_state === "string" ? data.market_state : null,
      },
    ];
  });
}

function reviewCadence(state: string, timeframe: string | null): string {
  const frame = timeframe || "execution timeframe";
  if (state === "PENDING_COUNCIL_REVIEW")
    return `First AI review after 3 fully closed ${frame} candles`;
  if (state === "HOLD_WITHOUT_TP" || state === "TRAILING")
    return `AI re-review after the next closed ${frame} candle`;
  if (state === "REVIEW_IN_PROGRESS") return "Council review in progress";
  if (state === "TP_SET" || state === "PARTIAL_TP_SET")
    return "TP order submitted; continuous AI re-review is not active";
  if (state === "EXIT_SUBMITTED") return "Exit submitted; awaiting venue reconciliation";
  return "No AI review currently scheduled";
}

function money(value: number | null, digits = 2) {
  return value === null || !Number.isFinite(value)
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: digits,
      }).format(value);
}

function age(value: string | null) {
  if (!value) return "not synced";
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "time unknown";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s ago`;
  return `${Math.floor(elapsed / 60_000)}m ago`;
}

export function LiveReviewDesk() {
  const { user, isReady } = useAuth();
  const queryClient = useQueryClient();
  const [symbol, setSymbol] = useState("ALL");
  const [streamConnected, setStreamConnected] = useState(false);
  const userId = user?.id;
  const walletIdentities = useQuery(exchangeWalletIdentitiesQuery(userId));

  const positions = useQuery({
    queryKey: ["autopilot-live-positions", userId],
    enabled: isReady && !!userId,
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<LivePosition[]> => {
      const { data, error } = await supabase
        .from("positions")
        .select(
          "id,connection_id,wallet_connection_id,autopilot_workflow_id,strategy_id,decision_id,exchange,pair,side,size,entry_price,mark_price,unrealized_pnl,leverage,synced_at,open_orders,tp_state,tp_venue_order_id,tp_execution_timeframe,tp_last_decision,tp_last_reviewed_at,strategy_metadata",
        )
        .eq("user_id", userId!)
        .eq("source", "live")
        .eq("status", "open")
        .order("opened_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as LivePosition[];
    },
  });

  const connections = useQuery({
    queryKey: ["autopilot-venue-connections", userId],
    enabled: isReady && !!userId,
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<VenueConnection[]> => {
      const { data, error } = await supabase
        .from("exchange_connections")
        .select("id,exchange,display_name")
        .eq("user_id", userId!);
      if (error) throw error;
      return data ?? [];
    },
  });

  const wallets = useQuery({
    queryKey: ["autopilot-wallet-connections", userId],
    enabled: isReady && !!userId,
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<WalletConnection[]> => {
      const { data, error } = await supabase
        .from("wallet_connections")
        .select("id,assigned_exchange_connection_id,label,public_address,status,provider")
        .eq("user_id", userId!)
        .eq("is_active", true);
      if (error) throw error;
      return data ?? [];
    },
  });

  const reviews = useQuery({
    queryKey: ["autopilot-live-reviews", userId],
    enabled: isReady && !!userId,
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<LiveReview[]> => {
      const { data, error } = await supabase
        .from("live_tp_council_reviews")
        .select(
          "position_id,review_seq,status,decision,rationale,reject_reason,degraded,completed_at,venue_order_id,council_inputs,council_opinions",
        )
        .eq("user_id", userId!)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as LiveReview[];
    },
  });

  useEffect(() => {
    if (!userId) return;
    // Realtime shortens UI latency; polling remains the fallback if replication
    // is unavailable or the connection drops. Both tables are owner-RLS scoped.
    const channel = supabase
      .channel(`autopilot-live-${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "positions", filter: `user_id=eq.${userId}` },
        () => {
          void queryClient.invalidateQueries({ queryKey: ["autopilot-live-positions", userId] });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "live_tp_council_reviews",
          filter: `user_id=eq.${userId}`,
        },
        () => {
          void queryClient.invalidateQueries({ queryKey: ["autopilot-live-reviews", userId] });
        },
      )
      .subscribe((status) => setStreamConnected(status === "SUBSCRIBED"));
    return () => {
      setStreamConnected(false);
      void supabase.removeChannel(channel);
    };
  }, [queryClient, userId]);

  const all = positions.data ?? [];
  const visible =
    symbol === "ALL" ? all : all.filter((position) => position.pair.startsWith(`${symbol}-`));
  const reviewByPosition = useMemo(() => {
    const latest = new Map<string, LiveReview>();
    for (const review of reviews.data ?? []) {
      if (!latest.has(review.position_id)) latest.set(review.position_id, review);
    }
    return latest;
  }, [reviews.data]);
  const unverifiedStops = all.filter(
    (position) =>
      !readPositionProtection(position.open_orders, position.pair, position.side).stops.length,
  ).length;
  const unverifiedTps = all.filter(
    (position) =>
      tpOrderEvidence(position.tp_state, position.tp_venue_order_id, position.open_orders) ===
      "unverified",
  ).length;

  return (
    <section
      className="tb-neu-panel mt-5 min-w-0 rounded-[28px] p-4 lg:p-5"
      aria-labelledby="live-review-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-violet-300/80">
            Live Autopilot
          </p>
          <h2 id="live-review-heading" className="mt-1 font-display text-xl lg:text-2xl">
            Position review desk
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-white/50">
            Venue positions and recorded Council decisions across symbols. A review is not an
            executed order until a venue order ID is recorded.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[10px] uppercase tracking-wider text-white/60">
            {streamConnected ? "Stream connected" : "Refreshing every 15s"}
          </span>
          <Link
            to="/trade"
            className="tb-neu-raised inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs text-violet-200 hover:text-white"
          >
            Trade desk <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>

      <PositionSymbolFilters
        selected={symbol}
        onSelect={setSymbol}
        options={["ALL", ...SYMBOLS].map((item) => ({
          symbol: item,
          count:
            item === "ALL"
              ? all.length
              : all.filter((position) => position.pair.startsWith(`${item}-`)).length,
        }))}
      />

      {(positions.isError || reviews.isError) && (
        <p
          role="alert"
          className="mt-4 rounded-2xl border border-rose-400/20 bg-rose-400/[0.08] p-3 text-xs text-rose-200"
        >
          Live review data could not be read. Position and decision status are unverified; refresh
          or check the connection.
        </p>
      )}
      {!positions.isError && positions.isLoading && (
        <p className="mt-4 text-sm text-white/50">Loading venue positions…</p>
      )}
      {!positions.isLoading && !positions.isError && all.length > 0 && unverifiedStops > 0 && (
        <div className="mt-4 flex items-start gap-2 rounded-2xl border border-amber-400/20 bg-amber-400/[0.07] p-3 text-xs text-amber-100">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {unverifiedStops} open {unverifiedStops === 1 ? "position has" : "positions have"} no
            stop visible in the reconciled venue orders. Do not treat an AI hold decision as proof
            of protection.
          </span>
        </div>
      )}
      {!positions.isLoading && !positions.isError && unverifiedTps > 0 && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-2xl border border-amber-400/25 bg-amber-400/[0.08] p-3 text-xs text-amber-100"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {unverifiedTps} open {unverifiedTps === 1 ? "position has" : "positions have"} a stored
            TP state without a matching order in the latest reconciled venue data. An order may have
            filled, been canceled, or been missed by reconciliation; this screen cannot establish
            which.
          </span>
        </div>
      )}

      {!positions.isLoading && !positions.isError && visible.length === 0 && (
        <div className="tb-neu-inset mt-4 rounded-2xl p-5 text-sm text-white/50">
          {all.length === 0
            ? "No open live positions. This view will populate from venue reconciliation when a trade fills."
            : `No open ${symbol} position.`}
        </div>
      )}
      <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-2">
        {visible.map((position) => {
          const review = reviewByPosition.get(position.id);
          const pnl = Number(position.unrealized_pnl ?? 0);
          const origin = String(position.strategy_metadata?.origin ?? "unattributed").replaceAll(
            "_",
            " ",
          );
          const protection = readPositionProtection(
            position.open_orders,
            position.pair,
            position.side,
            position.tp_venue_order_id,
          );
          const stopVisible = protection.stops.length > 0;
          const tpEvidence = tpOrderEvidence(
            position.tp_state,
            position.tp_venue_order_id,
            position.open_orders,
          );
          const opinions = opinionSummaries(review?.council_opinions);
          const marketRead =
            typeof review?.council_inputs?.market_read === "string"
              ? review.council_inputs.market_read.replaceAll("_", " ")
              : "Not assessed";
          const reviewMark = Number(review?.council_inputs?.mark_price);
          const currentMark = Number(position.mark_price);
          const sinceReview =
            review && Number.isFinite(reviewMark) && reviewMark > 0 && Number.isFinite(currentMark)
              ? (currentMark - reviewMark) *
                Number(position.size) *
                (position.side.toLowerCase() === "short" ? -1 : 1)
              : null;
          const venue = connections.data?.find((item) => item.id === position.connection_id);
          const explicitWallet = position.wallet_connection_id
            ? (wallets.data ?? []).find((item) => item.id === position.wallet_connection_id)
            : undefined;
          const matchingWallets =
            !position.wallet_connection_id && position.connection_id
              ? connectedWallets(
                  wallets.data ?? [],
                  position.connection_id,
                  walletIdentities.data ?? [],
                )
              : [];
          const resolvedWallet =
            explicitWallet ?? (matchingWallets.length === 1 ? matchingWallets[0] : undefined);
          const walletLabel = wallets.isError
            ? "Wallet lookup unavailable"
            : wallets.isLoading
              ? "Checking wallet link…"
              : resolvedWallet
                ? ""
                : !position.wallet_connection_id &&
                    (!position.connection_id || matchingWallets.length === 0)
                  ? "No linked wallet on record"
                  : matchingWallets.length > 1
                    ? "Multiple wallets linked — unresolved"
                    : "Recorded wallet is unavailable";
          const leverage = Number(position.leverage);
          const estimatedMargin =
            leverage > 0 && Number.isFinite(leverage)
              ? (Number(position.size) * Number(position.entry_price)) / leverage
              : null;
          return (
            <article key={position.id} className="tb-neu-inset min-w-0 rounded-[22px] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-violet-300" />
                    <h3 className="font-display text-lg">{position.pair}</h3>
                    <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase text-white/60">
                      {position.side}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] capitalize text-white/40">
                    {origin} · {position.size} units
                  </p>
                </div>
                <div className="text-right">
                  <p
                    className={`font-mono text-sm ${pnl >= 0 ? "text-emerald-300" : "text-rose-300"}`}
                  >
                    {money(position.unrealized_pnl)}
                  </p>
                  <p className="text-[10px] text-white/40">Unrealized P&amp;L</p>
                </div>
              </div>
              <dl className="mt-3 grid min-w-0 grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                <div className="min-w-0">
                  <dt className="text-white/40">Symbol</dt>
                  <dd className="mt-1 font-mono">{position.pair}</dd>
                </div>
                <div>
                  <dt className="text-white/40">Entry</dt>
                  <dd className="mt-1 font-mono">{money(Number(position.entry_price))}</dd>
                </div>
                <div>
                  <dt className="text-white/40">Margin (est.)</dt>
                  <dd
                    className="mt-1 font-mono"
                    title="Entry notional divided by venue-reported leverage; actual venue margin may differ."
                  >
                    {estimatedMargin === null ? "Unavailable" : `~${money(estimatedMargin)}`}
                  </dd>
                </div>
                <div>
                  <dt className="text-white/40">Leverage</dt>
                  <dd className="mt-1 font-mono">
                    {leverage > 0 && Number.isFinite(leverage) ? `${leverage}×` : "Unavailable"}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-white/40">Wallet</dt>
                  <dd
                    className="mt-1 break-words text-white/80"
                    title={resolvedWallet ? resolvedWallet.public_address : undefined}
                  >
                    <WalletIdentity
                      wallet={!wallets.isError && !wallets.isLoading ? resolvedWallet : null}
                      emptyLabel={walletLabel}
                    />
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-white/40">Exchange</dt>
                  <dd className="mt-1 break-words text-white/80">
                    <ExchangeIdentity
                      exchange={venue?.exchange ?? position.exchange}
                      name={venue?.display_name}
                      connectionId={position.connection_id}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-white/40">Mark</dt>
                  <dd className="mt-1 font-mono">
                    {money(position.mark_price === null ? null : Number(position.mark_price))}
                  </dd>
                </div>
                <div>
                  <dt className="text-white/40">Stop evidence</dt>
                  <dd className={`mt-1 ${stopVisible ? "text-emerald-300" : "text-amber-200"}`}>
                    {stopVisible ? "Order visible" : "Not verified"}
                  </dd>
                </div>
                <div>
                  <dt className="text-white/40">Venue sync</dt>
                  <dd className="mt-1">{age(position.synced_at)}</dd>
                </div>
              </dl>
              <div className="mt-3 border-t border-white/[0.07] pt-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-white/45">Latest Council review</span>
                  <span className="text-violet-200">
                    {review?.decision === "TRAIL"
                      ? "TRAIL recommendation only"
                      : (review?.decision?.replaceAll("_", " ") ??
                        position.tp_last_decision?.replaceAll("_", " ") ??
                        "Not reviewed")}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-white/45">Market structure read</span>
                  <span
                    className={marketRead === "Not assessed" ? "text-white/45" : "text-cyan-200"}
                  >
                    {marketRead}
                  </span>
                </div>
                {review?.rationale && (
                  <p className="mt-2 leading-5 text-white/70">{review.rationale}</p>
                )}
                {opinions.length > 0 && (
                  <p className="mt-2 text-[11px] leading-5 text-white/50">
                    Council votes:{" "}
                    {opinions
                      .map(
                        (opinion) =>
                          `${opinion.role} ${opinion.decision.replaceAll("_", " ")}${opinion.market_state ? ` (${opinion.market_state.replaceAll("_", " ")})` : ""}`,
                      )
                      .join(" · ")}
                  </p>
                )}
                {sinceReview !== null && (
                  <p
                    className={`mt-2 text-[11px] ${sinceReview >= 0 ? "text-emerald-300" : "text-rose-300"}`}
                  >
                    Position move since this review: {sinceReview >= 0 ? "+" : ""}
                    {money(sinceReview)} before fees. This is not the review's realized result.
                  </p>
                )}
                {review?.reject_reason && (
                  <p className="mt-2 text-amber-200">Order not submitted: {review.reject_reason}</p>
                )}
                <p className="mt-2 text-[11px] text-white/40">
                  {review
                    ? `Review #${review.review_seq} · ${age(review.completed_at)} · ${review.venue_order_id ? `venue order ${review.venue_order_id}` : "no order submitted"}`
                    : `Bot review state: ${position.tp_state.replaceAll("_", " ")}`}
                </p>
                <p className="mt-1 text-[11px] text-white/40">
                  {reviewCadence(position.tp_state, position.tp_execution_timeframe)}
                </p>
                {tpEvidence !== "not_applicable" && (
                  <p
                    className={`mt-1 text-[11px] ${tpEvidence === "visible" ? "text-emerald-300" : "text-amber-200"}`}
                  >
                    TP at venue:{" "}
                    {tpEvidence === "visible"
                      ? "matching open order visible"
                      : "not verified; stored TP state is not order proof"}
                  </p>
                )}
                <div className="mt-3 rounded-xl bg-black/20 p-3">
                  <PositionProtectionReadout
                    protection={protection}
                    syncedAt={position.synced_at}
                  />
                </div>
              </div>
            </article>
          );
        })}
      </div>
      <p className="mt-4 text-[11px] leading-5 text-white/40">
        Wallet is read from the position's recorded wallet assignment. Older positions without that
        attribution fall back only when exactly one active wallet matches the recorded exchange
        connection. Estimated margin is entry notional divided by reported leverage, not a venue
        margin balance.
      </p>
      <p className="mt-2 text-[11px] leading-5 text-white/40">
        Onyx and Council explanations are decision evidence, not a guarantee of profit. A
        pullback-versus-reversal read appears only when the live engine has recorded one; this desk
        will not invent it.
      </p>
    </section>
  );
}
