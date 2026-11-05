/**
 * Pure aggregation helpers for the Trade Performance card.
 *
 * READ-ONLY. Consumes raw trade rows and returns `PerformanceSection[]`
 * projections that the card renders. No fabrication: zero-state renders
 * literal "0" / "0%" / "$0.00" and empty rank tables read as
 * "no trades yet".
 */
import type {
  PerformanceSection,
  PerformanceStat,
  PerformanceRankRow,
  PerformanceRankColumn,
  PerformanceTone,
} from "@/components/trade/PerformanceCard";


export interface TradeRow {
  id: string;
  symbol: string;
  pnl: number;
  strategy: string | null;
  closed_at: string | null;
}

export interface OpenCounts {
  bySymbol: Map<string, number>;
  byStrategy: Map<string, number>;
  total: number;
}

const TURTLES: Array<{ key: string; label: string }> = [
  { key: "vanguard", label: "Vanguard" },
  { key: "accumulator", label: "Accumulator" },
  { key: "sweep", label: "Sweep" },
  { key: "hunter", label: "Hunter" },
  { key: "arbiter", label: "Arbiter" },
  { key: "scout", label: "Scout" },
];

// Persisted paper_positions.strategy for "sweep" is still "sniper" until the
// engine rename lands. Normalize so ranking rolls under the current name.
function normStrategy(s: string | null | undefined): string {
  if (!s) return "";
  const k = s.toLowerCase();
  if (k === "sniper") return "sweep";
  return k;
}

function fmtMoney(n: number): string {
  const sign = n < 0 ? "-" : n > 0 ? "+" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
function fmtMoneyPlain(n: number): string {
  return `$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
function fmtPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Base symbol without quote (BTC-USDT → BTC, BTCUSDT → BTC-ish fallback). */
function baseSymbol(sym: string): string {
  const s = sym.replace(/[_/]/g, "-");
  if (s.includes("-")) return s.split("-")[0];
  // fallback: strip common quote suffix
  return s.replace(/(USDT|USDC|USD)$/i, "") || s;
}

export function overallSection(
  trades: TradeRow[],
  openTotal: number,
  bookLabel: string,
): PerformanceSection {
  const attempted = trades.length;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl < 0).length;
  const winRate = attempted ? wins / attempted : 0;
  const pnl = trades.reduce((a, t) => a + t.pnl, 0);
  const stats: PerformanceStat[] = [
    { label: "Open", value: String(openTotal), tone: openTotal > 0 ? "accent" : "neutral" },
    { label: "Attempted", value: String(attempted) },
    { label: "Wins", value: String(wins), tone: wins > 0 ? "pos" : "neutral" },
    { label: "Losses", value: String(losses), tone: losses > 0 ? "neg" : "neutral" },
    {
      label: "Win rate",
      value: fmtPct(winRate),
      tone: attempted === 0 ? "neutral" : winRate >= 0.5 ? "pos" : "neg",
    },
    {
      label: "Realized",
      value: fmtMoney(pnl),
      tone: pnl > 0 ? "pos" : pnl < 0 ? "neg" : "neutral",
    },
  ];
  return {
    id: "overall",
    title: `Overall · ${bookLabel}`,
    stats,
  };
}

export function byStrategySection(
  trades: TradeRow[],
  open: OpenCounts,
): PerformanceSection {
  const byKey = new Map<string, TradeRow[]>();
  for (const t of trades) {
    const k = normStrategy(t.strategy);
    if (!k) continue;
    const list = byKey.get(k) ?? [];
    list.push(t);
    byKey.set(k, list);
  }

  const rows: PerformanceRankRow[] = TURTLES.map(({ key, label }) => {
    const list = byKey.get(key) ?? [];
    const n = list.length;
    const wins = list.filter((t) => t.pnl > 0);
    const losses = list.filter((t) => t.pnl < 0);
    const pnl = list.reduce((a, t) => a + t.pnl, 0);
    const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length
      ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length
      : 0;
    const openHere = open.byStrategy.get(key) ?? 0;
    return {
      key,
      name: label,
      subtitle: openHere > 0 ? `${openHere} open` : undefined,
      columns: [
        { label: "Trades", value: String(n) },
        {
          label: "Win %",
          value: n ? fmtPct(wins.length / n) : "—",
          tone: (n === 0 ? "neutral" : wins.length / n >= 0.5 ? "pos" : "neg") as PerformanceTone,
        },
        {
          label: "Realized",
          value: fmtMoney(pnl),
          tone: (pnl > 0 ? "pos" : pnl < 0 ? "neg" : "neutral") as PerformanceTone,
        },
        {
          label: "Avg W / L",
          value: n === 0 ? "—" : `${fmtMoneyPlain(avgWin)} / ${fmtMoneyPlain(avgLoss)}`,
        },
      ] satisfies PerformanceRankColumn[],

      sortKey: pnl,
    };
  }).sort((a, b) => (b.sortKey ?? 0) - (a.sortKey ?? 0));

  return {
    id: "by-strategy",
    title: "By strategy",
    subtitle: "ranked by realized",
    rows,
    emptyNote: trades.length === 0 ? "Stats populate as the bot trades." : undefined,
  };
}

export function bySymbolSection(
  trades: TradeRow[],
  open: OpenCounts,
): PerformanceSection {
  const byKey = new Map<string, TradeRow[]>();
  for (const t of trades) {
    const k = baseSymbol(t.symbol);
    const list = byKey.get(k) ?? [];
    list.push(t);
    byKey.set(k, list);
  }
  // If no trades yet, show a compact set of common bases at zero so the card
  // reads as "ready" rather than empty.
  const keys =
    byKey.size > 0
      ? Array.from(byKey.keys())
      : ["BTC", "ETH", "SOL", "DOGE", "XRP"];

  const rows: PerformanceRankRow[] = keys.map((k) => {
    const list = byKey.get(k) ?? [];
    const n = list.length;
    const wins = list.filter((t) => t.pnl > 0).length;
    const pnl = list.reduce((a, t) => a + t.pnl, 0);
    const openHere =
      open.bySymbol.get(k) ??
      // also check the full symbol → base mapping used by open positions
      Array.from(open.bySymbol.entries())
        .filter(([sym]) => baseSymbol(sym) === k)
        .reduce((a, [, v]) => a + v, 0);
    return {
      key: k,
      name: k,
      subtitle: openHere > 0 ? `${openHere} open` : undefined,
      columns: [
        { label: "Trades", value: String(n) },
        {
          label: "Win %",
          value: n ? fmtPct(wins / n) : "—",
          tone: (n === 0 ? "neutral" : wins / n >= 0.5 ? "pos" : "neg") as PerformanceTone,
        },
        {
          label: "Realized",
          value: fmtMoney(pnl),
          tone: (pnl > 0 ? "pos" : pnl < 0 ? "neg" : "neutral") as PerformanceTone,
        },
      ] satisfies PerformanceRankColumn[],

      sortKey: pnl,
    };
  }).sort((a, b) => (b.sortKey ?? 0) - (a.sortKey ?? 0));

  return {
    id: "by-symbol",
    title: "By symbol",
    subtitle: "ranked by realized",
    rows,
    emptyNote: trades.length === 0 ? "Stats populate as the bot trades." : undefined,
  };
}

export function streaksSection(trades: TradeRow[]): PerformanceSection {
  const closed = trades
    .filter((t) => !!t.closed_at)
    .slice()
    .sort(
      (a, b) =>
        new Date(a.closed_at!).getTime() - new Date(b.closed_at!).getTime(),
    );

  let curStreak = 0;
  let curDir: "W" | "L" | null = null;
  let longestW = 0;
  let longestL = 0;
  let runW = 0;
  let runL = 0;
  for (const t of closed) {
    if (t.pnl > 0) {
      runW += 1;
      runL = 0;
      longestW = Math.max(longestW, runW);
    } else if (t.pnl < 0) {
      runL += 1;
      runW = 0;
      longestL = Math.max(longestL, runL);
    } else {
      runW = 0;
      runL = 0;
    }
  }
  if (closed.length > 0) {
    const last = closed[closed.length - 1];
    if (last.pnl > 0) {
      curDir = "W";
      curStreak = runW;
    } else if (last.pnl < 0) {
      curDir = "L";
      curStreak = runL;
    }
  }

  // Best day = max sum of pnl grouped by YYYY-MM-DD
  const byDay = new Map<string, number>();
  for (const t of closed) {
    const d = new Date(t.closed_at!);
    const key = d.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + t.pnl);
  }
  let bestDay = 0;
  let bestDayKey: string | null = null;
  for (const [k, v] of byDay) {
    if (v > bestDay) {
      bestDay = v;
      bestDayKey = k;
    }
  }

  // Most-traded symbol
  const symbolCount = new Map<string, number>();
  for (const t of trades) {
    const k = baseSymbol(t.symbol);
    symbolCount.set(k, (symbolCount.get(k) ?? 0) + 1);
  }
  let topSym: string | null = null;
  let topN = 0;
  for (const [k, v] of symbolCount) {
    if (v > topN) {
      topSym = k;
      topN = v;
    }
  }

  const stats: PerformanceStat[] = [
    {
      label: "Current streak",
      value: curDir && curStreak > 0 ? `${curStreak}${curDir}` : "—",
      tone: curDir === "W" ? "pos" : curDir === "L" ? "neg" : "neutral",
    },
    {
      label: "Longest wins",
      value: longestW > 0 ? String(longestW) : "—",
      tone: longestW > 0 ? "pos" : "neutral",
    },
    {
      label: "Longest losses",
      value: longestL > 0 ? String(longestL) : "—",
      tone: longestL > 0 ? "neg" : "neutral",
    },
    {
      label: "Best day",
      value: bestDayKey ? fmtMoney(bestDay) : "—",
      tone: bestDay > 0 ? "pos" : "neutral",
    },
    {
      label: "Best day on",
      value: bestDayKey ? fmtDate(bestDayKey + "T12:00:00Z") : "—",
    },
    {
      label: "Most traded",
      value: topSym ? `${topSym} · ${topN}` : "—",
    },
  ];
  return {
    id: "streaks",
    title: "Streaks & records",
    stats,
  };
}

export function bestWorstSection(trades: TradeRow[]): PerformanceSection {
  let best: TradeRow | null = null;
  let worst: TradeRow | null = null;
  for (const t of trades) {
    if (!best || t.pnl > best.pnl) best = t;
    if (!worst || t.pnl < worst.pnl) worst = t;
  }
  const stats: PerformanceStat[] =
    trades.length === 0
      ? [
          { label: "Best trade", value: "—" },
          { label: "Best P&L", value: "—" },
          { label: "Best date", value: "—" },
          { label: "Worst trade", value: "—" },
          { label: "Worst P&L", value: "—" },
          { label: "Worst date", value: "—" },
        ]
      : [
          {
            label: "Best trade",
            value: `${baseSymbol(best!.symbol)} · ${normStrategy(best!.strategy) || "—"}`,
          },
          {
            label: "Best P&L",
            value: fmtMoney(best!.pnl),
            tone: best!.pnl >= 0 ? "pos" : "neg",
          },
          { label: "Best date", value: fmtDate(best!.closed_at) },
          {
            label: "Worst trade",
            value: `${baseSymbol(worst!.symbol)} · ${normStrategy(worst!.strategy) || "—"}`,
          },
          {
            label: "Worst P&L",
            value: fmtMoney(worst!.pnl),
            tone: worst!.pnl <= 0 ? "neg" : "pos",
          },
          { label: "Worst date", value: fmtDate(worst!.closed_at) },
        ];
  return {
    id: "best-worst",
    title: "Best & worst trade",
    stats,
    emptyNote:
      trades.length === 0 ? "Populates on the first closed trade." : undefined,
  };
}

export function buildPerformanceSections(input: {
  trades: TradeRow[];
  open: OpenCounts;
  bookLabel: string;
}): PerformanceSection[] {
  return [
    overallSection(input.trades, input.open.total, input.bookLabel),
    byStrategySection(input.trades, input.open),
    bySymbolSection(input.trades, input.open),
    streaksSection(input.trades),
    bestWorstSection(input.trades),
  ];
}
