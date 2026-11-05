import { TradingCockpit } from "@/components/home/TradingCockpit";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { usePortfolioTotals } from "@/hooks/usePortfolioTotals";
import { useTopByMarketCap, type MarketRow } from "@/hooks/useCoinGecko";
import { useMarketNews, type MarketNewsItem } from "@/hooks/useMarketNews";

import { CinematicHero } from "@/components/shell/CinematicHero";

import { ProfileAvatar } from "@/components/shell/ProfileAvatar";
import { SurfaceCard } from "@/components/phantom/SurfaceCard";
import { DeltaChip } from "@/components/phantom/DeltaChip";
import { DataTable, DataColumn } from "@/components/phantom/DataTable";
import { TokenIcon } from "@/components/phantom/TokenIcon";
import { turtleByAnyKey } from "@/lib/turtles";
import {
  Wallet,
  ChevronRight,
  TrendingUp,
  Newspaper,
  Activity,
  Radar,
  Bot,
} from "lucide-react";

import homeHero from "@/assets/home-hero.png.asset.json";
import { LifeProgressCard } from "@/components/home/LifeProgressCard";
import { RefreshPositionsButton } from "@/components/trade/RefreshPositionsButton";
import { MobileTradingDashboard } from "@/components/home/MobileTradingDashboard";
import { SuiteSelectCard } from "@/components/turtle/SuiteSelectCard";
import { SafetySummary } from "@/components/shared/SafetySummary";
import { OnyxDecisionsPanel } from "@/components/onyx/OnyxDecisionsPanel";

export const Route = createFileRoute("/_authenticated/home")({
  component: HomePage,
  validateSearch: (search: Record<string, unknown>): { layout?: "classic" } => ({ layout: search.layout === "classic" ? "classic" : undefined }),
  head: () => ({
    meta: [
      { title: "Overview · Quorumark" },
      { name: "description", content: "Your Quorumark decision control room." },
    ],
  }),
});

// Teal pulled from the underwater home hero art. NEVER --accent (violet),
// which is reserved for actions (FAB, primary CTA, active nav pill).
const HOME_HERO_ACCENT = "#4FD1C5";
const MARKET_HAIRLINE = "rgba(79, 209, 197, 0.30)";

// Balances below this USD threshold are hidden by default. Rows with an
// unknown price + zero amount are also hidden. Toggleable per-session.
const DUST_USD = 1;

const fmtUsd = (n: number) =>
  n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const fmtPrice = (n: number) => {
  if (!Number.isFinite(n)) return "—";
  const decimals = n >= 1000 ? 0 : n >= 1 ? 2 : n >= 0.01 ? 4 : 6;
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
};

// --- Row types for the desktop tables --------------------------------------
type HoldingRow = {
  key: string;
  asset: string;
  amount: number;
  usdValue: number | null;
};
type PositionRow = {
  key: string;
  instrument: string;
  side: "Long" | "Short";
  size: number | null;
  entry: number | null;
  mark: number | null;
  leverage: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
};

function isDust(r: HoldingRow): boolean {
  if (r.usdValue != null) return r.usdValue < DUST_USD;
  return r.amount === 0;
}

function HomePage() {
  const { layout } = Route.useSearch();
  return layout === "classic" ? <LegacyHomePage /> : <TradingCockpit />;
}

// Retained for owner comparison. Remove only after explicit cleanup confirmation.
function LegacyHomePage() {
  const { user, isReady } = useAuth();
  const navigate = useNavigate();
  const authed = isReady && !!user;
  const [showDust, setShowDust] = useState(false);

  const { data: profile, isPending: profilePending } = useQuery({
    queryKey: ["profile", user?.id],
    enabled: authed,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: active } = useQuery({
    queryKey: ["active-strategy", user?.id],
    enabled: authed,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_strategy")
        .select("market_type, cross_margin, strategies(*)")
        .eq("user_id", user!.id)
        .order("symbol", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const portfolio = usePortfolioTotals();

  useEffect(() => {
    if (profile && !profile.onboarding_complete) navigate({ to: "/onboarding" });
  }, [profile, navigate]);

  const strategySlug = (active?.strategies as { slug?: string } | null)?.slug ?? null;
  const activeTurtle = strategySlug ? turtleByAnyKey(strategySlug) : null;
  const hydrating = !authed || profilePending || portfolio.isLoading;

  const allHoldings: HoldingRow[] = useMemo(
    () =>
      (portfolio.walletEntries ?? []).flatMap((w) =>
        w.balances.slice(0, 8).map((b, i) => ({
          key: `${w.id}-${b.asset}-${i}`,
          asset: b.asset,
          amount: b.amount,
          usdValue: b.usdValue,
        })),
      ),
    [portfolio.walletEntries],
  );
  const holdings = showDust ? allHoldings : allHoldings.filter((r) => !isDust(r));
  const dustCount = allHoldings.length - holdings.length;

  const { data: livePositionsData } = useQuery({
    queryKey: ["home-positions", user?.id],
    enabled: authed,
    refetchInterval: 15_000,
    queryFn: async (): Promise<PositionRow[]> => {
      const { data, error } = await supabase
        .from("positions")
        .select(
          "id, pair, side, size, leverage, entry_price, mark_price, current_price, unrealized_pnl, pnl_pct",
        )
        .eq("user_id", user!.id)
        .eq("source", "live")
        .eq("status", "open")
        .order("opened_at", { ascending: false });
      if (error) throw error;
      const toNum = (v: unknown): number | null => {
        if (v == null) return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      return (data ?? []).map((r) => {
        const entry = toNum(r.entry_price);
        const markRaw = toNum(r.mark_price) ?? toNum(r.current_price);
        // Ruling #9 DEFECT 3 — mark identical to entry means feed isn't updating.
        const mark = markRaw != null && (entry == null || markRaw !== entry) ? markRaw : null;
        const pnl = mark != null ? toNum(r.unrealized_pnl) : null;
        const pnlPct = mark != null ? toNum(r.pnl_pct) : null;
        const lev = toNum(r.leverage);
        return {
          key: String(r.id),
          instrument: String(r.pair),
          side: (String(r.side).toLowerCase() === "short" ? "Short" : "Long") as "Long" | "Short",
          size: toNum(r.size),
          entry,
          mark,
          leverage: lev != null && lev > 0 ? lev : null,
          pnlUsd: pnl,
          pnlPct,
        };
      });
    },
  });
  const positions: PositionRow[] = livePositionsData ?? [];
  const connectionCount = (portfolio.verifiedConns?.length ?? 0) + portfolio.walletCount;
  const netOpenPnl = positions.reduce((sum, row) => sum + (row.pnlUsd ?? 0), 0);
  const netOpenPnlPct = portfolio.allocated > 0 ? (netOpenPnl / portfolio.allocated) * 100 : 0;
  const syncAgeSeconds = portfolio.exchangeUpdatedAt
    ? Math.max(0, Math.round((Date.now() - portfolio.exchangeUpdatedAt) / 1_000))
    : null;

  return (
    <div className="min-h-[100dvh] bg-black text-white">
      {/* Mobile keeps the focused cockpit; desktop gets the full command view. */}
      <div className="lg:hidden">
        <MobileTradingDashboard
          totalUsd={portfolio.totalUsd ?? 0}
          available={portfolio.available ?? 0}
          allocated={portfolio.allocated ?? 0}
          loading={hydrating}
          connectionCount={connectionCount}
          holdings={holdings}
          positions={positions}
        />
      </div>

      {/* ============ DESKTOP (>=1024) ============ */}
      <div className="hidden lg:block">
        <CinematicHero
          image={homeHero.url}
          className="lg:h-[220px]"
          scrimVariant="dissolve-bottom"
          glassText="tight"
          heroAccent={HOME_HERO_ACCENT}
          eyebrow="Quorumark · Control room"
          title={
            <>
              Protect your world.{" "}
              <span style={{ color: HOME_HERO_ACCENT }}>Command your capital.</span>
            </>
          }
          subtitle={
            activeTurtle
              ? `${activeTurtle.name} · ${activeTurtle.role} on watch`
              : "Assign a strategy to bring your world online."
          }
          chrome={
            <div className="flex items-center justify-end px-8 pt-6">
              <ProfileAvatar />
            </div>
          }
        />
        <div className="mx-auto max-w-[1440px] px-6 py-6 2xl:px-8">
          <SafetySummary className="mb-5" />

          {/* Trading capital — the first operational read after safety state. */}
          <div className="grid grid-cols-12 gap-4">
            <StatCard
              label="Total Equity"
              value={hydrating ? "—" : fmtUsd(portfolio.totalUsd ?? 0)}
              className="col-span-4"
              accent
            />
            <StatCard
              label="Cash · Free Collateral"
              value={hydrating ? "—" : fmtUsd(portfolio.available ?? 0)}
              hint={
                syncAgeSeconds == null
                  ? `${portfolio.verifiedConns?.length ?? 0} verified venues`
                  : `${portfolio.verifiedConns?.length ?? 0} verified · synced ${syncAgeSeconds}s ago`
              }
              className="col-span-4"
              icon={<Wallet className="h-4 w-4" />}
            />
            <StatCard
              label="Allocated"
              value={hydrating ? "—" : fmtUsd(portfolio.allocated ?? 0)}
              hint="In open trades"
              delta={<DeltaChip percent={netOpenPnlPct} usd={netOpenPnl} className="text-[11px]" />}
              className="col-span-4"
              icon={<TrendingUp className="h-4 w-4" />}
            />
          </div>

          {/* Replace product promos with live, task-oriented controls. */}
          <div className="mt-5">
            <HomeCommandDeck
              available={portfolio.available ?? 0}
              positionCount={positions.length}
              venueCount={portfolio.verifiedConns?.length ?? 0}
              strategyName={activeTurtle?.name ?? null}
              strategyRole={activeTurtle?.role ?? null}
              loading={hydrating}
            />
          </div>

          {/* Recommendations must be visible without opening the Onyx drawer. */}
          <div className="mt-5">
            <OnyxDecisionsPanel compact />
          </div>

          {/* Exposure stays above secondary content so it is always findable. */}
          <div className="mt-5 grid grid-cols-12 gap-4">
            <section className="col-span-7">
              <div className="flex items-center gap-2">
                <DesktopSectionHeader title="Positions" to="/trade" cta="Open trade" />
                <RefreshPositionsButton />
              </div>
              <DataTable<PositionRow>
                className="mt-2"
                rowHeight={48}
                columns={POSITION_COLUMNS}
                rows={positions}
                rowKey={(r) => r.key}
                onRowClick={(r) =>
                  navigate({
                    to: "/trade",
                    search: { book: "live", symbol: r.instrument.replace("/", "-") },
                  })
                }
                empty={
                  <div>
                    <p className="text-[14px]">No open positions.</p>
                    <p className="mt-1 text-[12px] text-white/45">
                      Live positions land here the moment your strategy fires.
                    </p>
                  </div>
                }
              />
            </section>
            <section className="col-span-5">
              <DesktopSectionHeader
                title="Holdings"
                to="/exchanges"
                cta={
                  dustCount > 0 || showDust
                    ? showDust
                      ? "Hide dust"
                      : `Show ${dustCount} small`
                    : "Manage"
                }
                onCta={dustCount > 0 || showDust ? () => setShowDust((v) => !v) : undefined}
              />
              <DataTable<HoldingRow>
                className="mt-2"
                rowHeight={48}
                columns={HOLDING_COLUMNS}
                rows={holdings}
                rowKey={(r) => r.key}
                empty={
                  <div>
                    <p className="text-[14px]">No balances yet.</p>
                    <p className="mt-1 text-[12px] text-white/45">
                      Connect an exchange or wallet to populate this table.
                    </p>
                  </div>
                }
              />
            </section>
          </div>

          {/* One compact live ticker replaces the duplicate market list. */}
          <div className="mt-5">
            <MarketFeedSection desktop />
          </div>

          {/* Strategy selection and deployment live on Home. */}
          <div className="mt-6">
            <SuiteSelectCard embedded />
          </div>

          {/* Planning stays available without pushing live exposure below the fold. */}
          <div className="mt-6">
            <LifeProgressCard />
          </div>

          {/* Market context stays available without legacy brand promotion. */}
          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <MarketNewsSection />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function HomeCommandDeck({
  available,
  positionCount,
  venueCount,
  strategyName,
  strategyRole,
  loading,
}: {
  available: number;
  positionCount: number;
  venueCount: number;
  strategyName: string | null;
  strategyRole: string | null;
  loading: boolean;
}) {
  return (
    <section aria-label="Trading command center" className="grid gap-4 lg:grid-cols-2">
      <div className="tb-home-command-card relative overflow-hidden rounded-[24px] p-4">
        <div className="pointer-events-none absolute -right-10 -top-14 h-36 w-36 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="relative flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-200/70">
              Live execution
            </p>
            <h2 className="mt-1 text-[18px] font-semibold text-white">Trade workspace</h2>
            <p className="mt-1 text-[12px] leading-5 text-white/50">
              {venueCount > 0
                ? `${venueCount} verified venue${venueCount === 1 ? "" : "s"} ready · ${positionCount} open position${positionCount === 1 ? "" : "s"}`
                : "Connect and verify a venue before sending a live order."}
            </p>
          </div>
          <span className="tb-neu-inset grid h-10 w-10 shrink-0 place-items-center rounded-full text-cyan-300">
            <Activity className="h-4 w-4" />
          </span>
        </div>
        <div className="relative mt-3 flex items-end justify-between gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Available</p>
            <p className="mt-0.5 text-[18px] font-semibold tabular-nums text-white">
              {loading ? "—" : fmtUsd(available)}
            </p>
          </div>
          <Link
            to="/trade"
            search={{ book: "live" }}
            className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-[11px] font-semibold text-white"
          >
            Open desk <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>

      <div className="tb-home-command-card relative overflow-hidden rounded-[24px] p-4">
        <div className="pointer-events-none absolute -right-8 -top-12 h-36 w-36 rounded-full bg-violet-500/12 blur-3xl" />
        <div className="relative flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-violet-300/75">
              Strategy control
            </p>
            <h2 className="mt-1 truncate text-[18px] font-semibold text-white">
              {strategyName ?? "Choose an active strategy"}
            </h2>
            <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-white/50">
              {strategyRole ??
                "Scout the market, review qualified signals, and configure automation."}
            </p>
          </div>
          <span className="tb-neu-inset grid h-10 w-10 shrink-0 place-items-center rounded-full text-violet-300">
            <Bot className="h-4 w-4" />
          </span>
        </div>
        <div className="relative mt-3 flex items-center justify-end gap-2">
          <Link
            to="/scout"
            className="inline-flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-[11px] font-semibold text-white/75"
          >
            <Radar className="h-3.5 w-3.5" /> Scout
          </Link>
          <Link
            to="/automation"
            className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-[11px] font-semibold text-white"
          >
            Configure <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// Market feed — Top 10 by market cap (CoinGecko /coins/markets)
// Stablecoins filtered so every tile is a live mover.
// ============================================================================

function MarketFeedSection({ desktop = false }: { desktop?: boolean }) {
  const { data, isLoading, isError, isFetching, dataUpdatedAt } = useTopByMarketCap();
  const rows = data ?? [];

  return (
    <section>
      <div className="flex items-baseline justify-between">
        <h2
          className={(desktop ? "text-[18px]" : "text-[19px]") + " font-semibold text-white"}
          style={{ letterSpacing: "-0.02em" }}
        >
          Markets
        </h2>
        <span className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-white/40">
          {isError
            ? "Markets unavailable"
            : isLoading
              ? "Syncing…"
              : isFetching
                ? "Updating…"
                : dataUpdatedAt
                  ? `Updated ${new Date(dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                  : "Live"}
        </span>
      </div>

      {isError ? (
        <div
          className="mt-2 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 text-[12px] text-white/50"
          role="status"
        >
          Markets unavailable — real-time feed will resume shortly.
        </div>
      ) : (
        <div className="tb-market-marquee mt-2" aria-label="Live market prices">
          {isLoading && rows.length === 0 ? (
            <div className="flex gap-2 px-1 py-1">
              {Array.from({ length: 7 }).map((_, i) => (
                <MarketTileSkeleton key={i} />
              ))}
            </div>
          ) : (
            <div className="tb-market-marquee-track py-1">
              <div className="flex gap-2 pr-2">
                {rows.map((r) => (
                  <MarketTile key={r.id} row={r} />
                ))}
              </div>
              <div className="flex gap-2 pr-2" aria-hidden="true">
                {rows.map((r) => (
                  <MarketTile key={`copy-${r.id}`} row={r} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function MarketTile({ row }: { row: MarketRow }) {
  const positive = row.change24h >= 0;
  return (
    <div
      className="tb-market-tile shrink-0 rounded-2xl bg-white/[0.04] px-3 py-2.5 transition"
      style={{ borderBottom: `1.5px solid ${MARKET_HAIRLINE}` }}
    >
      <div className="flex items-center gap-2">
        <img
          src={row.image}
          alt=""
          width={24}
          height={24}
          loading="lazy"
          decoding="async"
          className="h-5 w-5 rounded-full"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-semibold leading-tight text-white">
            {row.symbol}
          </p>
          <p className="truncate text-[10px] uppercase tracking-wider text-white/40">{row.name}</p>
        </div>
      </div>
      <div
        className="mt-1.5 text-[13px] font-semibold leading-tight tabular-nums text-white"
        style={{ letterSpacing: "-0.01em" }}
      >
        {fmtPrice(row.price)}
      </div>
      <div
        className="mt-1 inline-flex items-center rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums"
        style={{
          color: positive ? "var(--positive)" : "var(--negative)",
          background: positive
            ? "color-mix(in oklab, var(--positive) 12%, transparent)"
            : "color-mix(in oklab, var(--negative) 12%, transparent)",
        }}
      >
        {positive ? "+" : ""}
        {row.change24h.toFixed(2)}%
      </div>
    </div>
  );
}

function MarketTileSkeleton() {
  return (
    <div
      className="tb-market-tile shrink-0 animate-pulse rounded-2xl bg-white/[0.04] px-3 py-2.5"
      style={{ borderBottom: `1.5px solid ${MARKET_HAIRLINE}` }}
    >
      <div className="flex items-center gap-2">
        <div className="h-6 w-6 rounded-full bg-white/10" />
        <div className="flex-1 space-y-1">
          <div className="h-3 w-10 rounded bg-white/10" />
          <div className="h-2 w-14 rounded bg-white/5" />
        </div>
      </div>
      <div className="mt-2 h-4 w-20 rounded bg-white/10" />
      <div className="mt-1 h-3 w-12 rounded bg-white/5" />
    </div>
  );
}




// ============================================================================
// Market News — real CoinDesk RSS via /market-news server function proxy.
// Honest empty state when the feed is unreachable or empty. Never fabricate.
// ============================================================================

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const min = Math.max(0, Math.round(diff / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.round(d / 7);
  return `${w}w ago`;
}

function MarketNewsSection() {
  const { data, isLoading, isError } = useMarketNews();
  const items = (data ?? []).slice(0, 5);
  const showEmpty = !isLoading && (isError || items.length === 0);

  return (
    <section>
      <div className="flex items-baseline justify-between">
        <h2
          className="text-[22px] font-semibold text-white lg:text-[20px]"
          style={{ letterSpacing: "-0.02em" }}
        >
          <Newspaper
            className="mr-2 inline h-4 w-4 -translate-y-[2px]"
            style={{ color: HOME_HERO_ACCENT }}
          />
          Market News
        </h2>
        <span className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-white/40">
          CoinDesk
        </span>
      </div>

      <div className="mt-2.5 overflow-hidden rounded-2xl bg-white/[0.04]">
        {isLoading ? (
          <ul>
            {Array.from({ length: 4 }).map((_, i) => (
              <li
                key={i}
                className="animate-pulse border-b border-white/5 px-3 py-2.5 last:border-b-0"
              >
                <div className="h-3 w-16 rounded bg-white/10" />
                <div className="mt-2 h-3.5 w-11/12 rounded bg-white/10" />
                <div className="mt-1.5 h-3 w-1/2 rounded bg-white/5" />
              </li>
            ))}
          </ul>
        ) : showEmpty ? (
          <div className="px-4 py-6 text-center text-[12.5px] text-white/50">
            News unavailable right now.
          </div>
        ) : (
          <ul>
            {items.map((it) => (
              <NewsRow key={it.link} item={it} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function NewsRow({ item }: { item: MarketNewsItem }) {
  return (
    <li className="border-b border-white/5 last:border-b-0">
      <a
        href={item.link}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-start gap-2.5 px-3 py-2.5 transition hover:bg-white/[0.03]"
      >
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt=""
            width={40}
            height={40}
            loading="lazy"
            decoding="async"
            className="h-10 w-10 shrink-0 rounded-lg object-cover"
          />
        ) : (
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white/[0.05]">
            <Newspaper className="h-4 w-4 text-white/50" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
              style={{
                color: HOME_HERO_ACCENT,
                background: "color-mix(in oklab, " + HOME_HERO_ACCENT + " 14%, transparent)",
              }}
            >
              {item.source}
            </span>
            <span className="text-[10.5px] text-white/40">{relativeTime(item.publishedAt)}</span>
          </div>
          <p className="mt-1 line-clamp-2 text-[12.5px] font-medium leading-snug text-white">
            {item.title}
          </p>
        </div>
      </a>
    </li>
  );
}

// ============================================================================
// Shared bits
// ============================================================================

function DesktopSectionHeader({
  title,
  to,
  cta,
  onCta,
}: {
  title: string;
  to: string;
  cta: string;
  onCta?: () => void;
}) {
  return (
    <div className="flex flex-1 items-baseline justify-between">
      <h2 className="text-[20px] font-semibold text-white" style={{ letterSpacing: "-0.02em" }}>
        {title}
      </h2>
      {onCta ? (
        <button
          type="button"
          onClick={onCta}
          className="text-[12px] font-semibold text-white/60 transition hover:text-white"
        >
          {cta} <ChevronRight className="inline h-3 w-3" />
        </button>
      ) : (
        <Link
          to={to}
          className="text-[12px] font-semibold text-white/60 transition hover:text-white"
        >
          {cta} <ChevronRight className="inline h-3 w-3" />
        </Link>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  delta,
  hint,
  icon,
  className,
  accent,
}: {
  label: string;
  value: string;
  delta?: React.ReactNode;
  hint?: string;
  icon?: React.ReactNode;
  className?: string;
  accent?: boolean;
}) {
  return (
    <SurfaceCard className={"flex flex-col gap-2 rounded-[22px] !p-4 " + (className ?? "")}>
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/45">
        {icon}
        {label}
      </div>
      <div
        className={
          "text-[28px] font-bold leading-none tabular-nums " +
          (accent ? "text-white" : "text-white/95")
        }
        style={{ letterSpacing: "-0.02em" }}
      >
        {value}
      </div>
      {delta ?? (hint && <p className="text-[12px] text-white/50">{hint}</p>)}
    </SurfaceCard>
  );
}


// --- Desktop table columns -------------------------------------------------
const HOLDING_COLUMNS: DataColumn<HoldingRow>[] = [
  {
    key: "asset",
    header: "Asset",
    sortable: true,
    accessor: (r) => r.asset,
    render: (r) => (
      <div className="flex items-center gap-3">
        <TokenIcon symbol={r.asset} size={28} />
        <span className="font-semibold">{r.asset}</span>
      </div>
    ),
  },
  {
    key: "amount",
    header: "Amount",
    align: "right",
    sortable: true,
    accessor: (r) => r.amount,
    render: (r) => r.amount.toLocaleString(undefined, { maximumFractionDigits: 6 }),
  },
  {
    key: "usd",
    header: "USD Value",
    align: "right",
    sortable: true,
    accessor: (r) => r.usdValue ?? 0,
    render: (r) => (r.usdValue != null ? fmtUsd(r.usdValue) : "—"),
  },
];

const POSITION_COLUMNS: DataColumn<PositionRow>[] = [
  { key: "instrument", header: "Instrument", sortable: true, accessor: (r) => r.instrument },
  { key: "side", header: "Side", sortable: true, accessor: (r) => r.side },
  {
    key: "size",
    header: "Size",
    align: "right",
    sortable: true,
    accessor: (r) => r.size ?? 0,
    render: (r) =>
      r.size != null ? r.size.toLocaleString(undefined, { maximumFractionDigits: 6 }) : "—",
  },
  {
    key: "entry",
    header: "Entry",
    align: "right",
    sortable: true,
    accessor: (r) => r.entry ?? 0,
    render: (r) => (r.entry != null ? fmtUsd(r.entry) : "—"),
  },
  {
    key: "mark",
    header: "Mark",
    align: "right",
    sortable: true,
    accessor: (r) => r.mark ?? 0,
    render: (r) => (r.mark != null ? fmtUsd(r.mark) : "—"),
  },
  {
    key: "lev",
    header: "Lev",
    align: "right",
    sortable: true,
    accessor: (r) => r.leverage ?? 0,
    render: (r) => (r.leverage != null ? `${r.leverage}×` : "—"),
  },
  {
    key: "pnlUsd",
    header: "PnL $",
    align: "right",
    sortable: true,
    accessor: (r) => r.pnlUsd ?? 0,
    render: (r) =>
      r.pnlUsd == null ? (
        <span className="text-white/40">—</span>
      ) : (
        <span
          className={
            r.pnlUsd > 0
              ? "text-[color:var(--positive)]"
              : r.pnlUsd < 0
                ? "text-[color:var(--negative)]"
                : "text-white/60"
          }
        >
          {fmtUsd(r.pnlUsd)}
        </span>
      ),
  },
  {
    key: "pnlPct",
    header: "PnL %",
    align: "right",
    sortable: true,
    accessor: (r) => r.pnlPct ?? 0,
    render: (r) =>
      r.pnlPct != null ? (
        <DeltaChip percent={r.pnlPct} />
      ) : (
        <span className="text-white/40">—</span>
      ),
  },
];

