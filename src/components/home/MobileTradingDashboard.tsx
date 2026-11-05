import { RefreshPositionsButton } from "@/components/trade/RefreshPositionsButton";
import { Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Activity, ArrowDownLeft, ArrowUpRight, PlugZap, Radar, Sparkles } from "lucide-react";
import { useState } from "react";
import { useCandles, type Interval } from "@/hooks/useCandles";
import { useMarketTickers } from "@/hooks/useCoinGecko";
import { ProfileAvatar } from "@/components/shell/ProfileAvatar";
import { SuiteSelectCard } from "@/components/turtle/SuiteSelectCard";
import { BotLineChart } from "@/components/trade/BotLineChart";
import { SafetySummary } from "@/components/shared/SafetySummary";
import { OnyxDecisionsPanel } from "@/components/onyx/OnyxDecisionsPanel";

type Holding = { key: string; asset: string; amount: number; usdValue: number | null };
type Position = {
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

type Props = {
  totalUsd: number;
  available: number;
  allocated: number;
  loading: boolean;
  connectionCount: number;
  holdings: Holding[];
  positions: Position[];
};

const money = (value: number) =>
  value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const price = (value: number) =>
  value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1_000 ? 0 : 2,
  });

const intervals: Interval[] = ["5m", "15m", "1h", "4h"];

export function MobileTradingDashboard(props: Props) {
  const [interval, setInterval] = useState<Interval>("15m");
  const {
    data: candles = [],
    isError: chartError,
    isFetching,
  } = useCandles("BTC-USDT", interval, 80);
  const { data: tickers = [] } = useMarketTickers();
  const btc = tickers.find((ticker) => ticker.symbol === "BTC");
  const latest = candles.at(-1)?.close ?? btc?.usd;
  const first = candles.at(0)?.close;
  const change = first && latest ? ((latest - first) / first) * 100 : btc?.change24h;
  const positive = (change ?? 0) >= 0;

  return (
    <main className="tb-mobile-dashboard relative mx-auto min-h-[100dvh] w-full max-w-[430px] overflow-hidden bg-[#0d0e15] px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] text-white">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(circle_at_22%_0%,rgba(174,82,255,.22),transparent_58%)]" />

      <header className="relative z-10 flex items-center justify-between py-2">
        <div className="flex items-center gap-3">
          <div className="tb-neu-raised grid h-11 w-11 place-items-center rounded-full">
            <img
              src="/brand/turtlebot-logo.png"
              alt="TurtleBot"
              className="h-8 w-8 object-contain"
            />
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/45">
              TurtleBot
            </p>
            <h1 className="text-[19px] font-semibold tracking-tight">Trading cockpit</h1>
          </div>
        </div>
        <div className="tb-neu-raised rounded-full p-1">
          <ProfileAvatar />
        </div>
      </header>

      <motion.section
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="tb-neu-panel relative mt-5 overflow-hidden rounded-[30px] p-5"
      >
        <div className="absolute -right-10 -top-12 h-36 w-36 rounded-full bg-violet-500/15 blur-3xl" />
        <div className="relative flex items-start justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-white/45">
              Total portfolio
            </p>
            <p className="mt-2 text-[35px] font-semibold leading-none tracking-[-0.04em]">
              {props.loading ? "—" : money(props.totalUsd)}
            </p>
          </div>
          <span className="tb-neu-inset inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-[10px] font-semibold text-emerald-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-300" /> LIVE
          </span>
        </div>
        <div className="relative mt-5 grid grid-cols-2 gap-3">
          <MiniStat label="Available" value={props.loading ? "—" : money(props.available)} />
          <MiniStat label="In trades" value={props.loading ? "—" : money(props.allocated)} />
        </div>
      </motion.section>

      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.06 }}
        className="tb-neu-panel mt-5 rounded-[30px] p-4"
        aria-label="Bitcoin price chart"
      >
        <div className="flex items-start justify-between px-1">
          <div>
            <div className="flex items-center gap-2">
              <span className="tb-neu-inset grid h-9 w-9 place-items-center rounded-full text-sm font-bold text-[#f7a927]">
                ₿
              </span>
              <div>
                <p className="text-[15px] font-semibold">BTC / USDT</p>
                <p className="text-[10px] uppercase tracking-wider text-white/40">
                  ApeX live market
                </p>
              </div>
            </div>
            <p className="mt-4 text-[27px] font-semibold tracking-tight">
              {latest ? price(latest) : "—"}
            </p>
            <p
              className={
                positive
                  ? "text-xs font-semibold text-emerald-300"
                  : "text-xs font-semibold text-rose-300"
              }
            >
              {change == null
                ? "Market sync"
                : `${positive ? "+" : ""}${change.toFixed(2)}% selected range`}
            </p>
          </div>
          <Link
            to="/trade"
            className="tb-neu-raised grid h-10 w-10 place-items-center rounded-full text-violet-300"
            aria-label="Open full trading desk"
          >
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </div>

        <div className="mt-3 h-[188px] w-full">
          {chartError ? (
            <div className="grid h-full place-items-center text-center text-xs text-white/45">
              Live chart is reconnecting.
            </div>
          ) : (
            <BotLineChart
              candles={candles}
              height={188}
              regime={positive ? "bullish" : "bearish"}
              windowMinutes={interval === "5m" ? 40 : interval === "15m" ? 120 : 360}
            />
          )}
        </div>
        <div className="tb-neu-inset grid grid-cols-4 gap-1 rounded-2xl p-1">
          {intervals.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={interval === item}
              onClick={() => setInterval(item)}
              className={
                interval === item
                  ? "tb-neu-raised rounded-xl py-2 text-[11px] font-semibold text-violet-200"
                  : "rounded-xl py-2 text-[11px] font-medium text-white/40"
              }
            >
              {item}
            </button>
          ))}
        </div>
        <p className="mt-2 px-1 text-[9px] uppercase tracking-[0.15em] text-white/30">
          {isFetching ? "Updating market…" : "Drag for detail · tap arrow for full desk"}
        </p>
      </motion.section>

      <section className="mt-5 grid grid-cols-4 gap-3" aria-label="Quick actions">
        <QuickAction to="/home" hash="onyx" label="Ask Onyx" icon={<Sparkles />} illuminated />
        <QuickAction to="/scout" label="Scout" icon={<Radar />} />
        <QuickAction to="/trade" label="Trade" icon={<Activity />} />
        <QuickAction to="/exchanges" label="Connect" icon={<PlugZap />} />
      </section>

      <div className="mt-5">
        <OnyxDecisionsPanel compact />
      </div>

      <SafetySummary className="mt-5" />

      <SuiteSelectCard embedded />

      <DashboardList
        title="Open positions"
        count={props.positions.length}
        to="/trade"
        book="live"
        empty="No live positions. TurtleBot will surface one here when a strategy opens it."
      >
        {props.positions.slice(0, 3).map((position) => (
          <div
            key={position.key}
            className="tb-neu-inset flex items-center justify-between rounded-2xl px-4 py-3"
          >
            <div>
              <p className="text-sm font-semibold">{position.instrument}</p>
              <p className="text-[10px] uppercase tracking-wider text-white/40">
                {position.side}
                {position.leverage != null ? ` · ${position.leverage}x` : ""}
              </p>
              <p className="mt-1 text-[10px] tabular-nums text-white/35">
                Size{" "}
                {position.size == null
                  ? "—"
                  : position.size.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                {" · "}Entry {position.entry == null ? "—" : price(position.entry)}
                {" · "}Mark {position.mark == null ? "—" : price(position.mark)}
              </p>
            </div>
            <div className="text-right">
              <p
                className={
                  (position.pnlUsd ?? 0) >= 0
                    ? "text-sm font-semibold text-emerald-300"
                    : "text-sm font-semibold text-rose-300"
                }
              >
                {position.pnlUsd == null ? "—" : money(position.pnlUsd)}
              </p>
              <p className="text-[10px] text-white/40">
                {position.pnlPct == null
                  ? "Live"
                  : `${position.pnlPct >= 0 ? "+" : ""}${position.pnlPct.toFixed(2)}%`}
              </p>
            </div>
          </div>
        ))}
      </DashboardList>

      {(props.holdings.length > 0 || props.connectionCount === 0) && (
        <DashboardList
          title="Assets"
          count={props.holdings.length}
          to="/exchanges"
          empty="Connect a verified exchange or wallet to automate balances here."
        >
          {props.holdings.slice(0, 4).map((holding) => (
            <div
              key={holding.key}
              className="tb-neu-inset flex items-center justify-between rounded-2xl px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <span className="tb-neu-raised grid h-9 w-9 place-items-center rounded-full text-[11px] font-bold">
                  {holding.asset.slice(0, 3)}
                </span>
                <div>
                  <p className="text-sm font-semibold">{holding.asset}</p>
                  <p className="text-[10px] text-white/40">
                    {holding.amount.toLocaleString(undefined, { maximumFractionDigits: 5 })}
                  </p>
                </div>
              </div>
              <p className="text-sm font-semibold">
                {holding.usdValue == null ? "—" : money(holding.usdValue)}
              </p>
            </div>
          ))}
        </DashboardList>
      )}
    </main>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="tb-neu-inset rounded-2xl px-4 py-3">
      <p className="text-[10px] uppercase tracking-wider text-white/35">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold">{value}</p>
    </div>
  );
}

function QuickAction({
  to,
  hash,
  label,
  icon,
  illuminated = false,
}: {
  to: "/trade" | "/exchanges" | "/life-map" | "/home" | "/scout";
  hash?: string;
  label: string;
  icon: React.ReactNode;
  illuminated?: boolean;
}) {
  return (
    <Link to={to} hash={hash} className="group flex min-w-0 flex-col items-center gap-2">
      <span
        className={`tb-neu-raised grid h-14 w-14 place-items-center rounded-[20px] transition-transform group-active:scale-95 [&_svg]:h-5 [&_svg]:w-5 ${
          illuminated
            ? "text-cyan-300 shadow-[0_0_18px_rgba(34,211,238,0.30),0_0_34px_rgba(153,69,255,0.18)] ring-1 ring-cyan-300/30"
            : "text-violet-300"
        }`}
      >
        {icon}
      </span>
      <span className="truncate text-[10px] font-medium text-white/50">{label}</span>
    </Link>
  );
}

function DashboardList({
  title,
  count,
  to,
  book,
  empty,
  children,
}: {
  title: string;
  count: number;
  to: "/trade" | "/exchanges";
  book?: "paper" | "live";
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-5">
      <div className="mb-3 flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {count > 0 && (
            <span className="tb-neu-inset rounded-full px-2 py-0.5 text-[10px] text-white/45">
              {count}
            </span>
          )}
        </div>
        {book ? <RefreshPositionsButton book={book} /> : null}
        <Link
          to={to}
          search={to === "/trade" && book ? { book } : undefined}
          className="text-[11px] font-medium text-violet-300"
        >
          View all
        </Link>
      </div>
      <div className="tb-neu-panel space-y-3 rounded-[26px] p-3">
        {count === 0 ? (
          <div className="flex items-center gap-3 px-2 py-3">
            <span className="tb-neu-inset grid h-10 w-10 shrink-0 place-items-center rounded-full text-white/35">
              <ArrowDownLeft className="h-4 w-4" />
            </span>
            <p className="text-[11px] leading-relaxed text-white/45">{empty}</p>
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
