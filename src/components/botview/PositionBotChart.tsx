/**
 * Bot View overlay — TIGHT LIVE WINDOW · AUTO-SCALED Y · SMOOTH REFRESH.
 *
 *  1. TIGHT TIME WINDOW: only the trailing ~WINDOW_MINUTES of price data
 *     (see WINDOW_MINUTES default) is drawn, so small % moves fill the
 *     view and every tick visibly glides.
 *  2. AUTO-SCALING Y-AXIS: domain hugs the visible min/max plus a dynamic
 *     pad (see computeYDomain). Domain transitions are eased frame-to-
 *     frame via easeDomain so the axis doesn't snap on every tick.
 *  3. FAST SMOOTH REFRESH: recharts Line uses monotone curve + short
 *     isAnimationActive so the trailing point eases into place and the
 *     window slides continuously.
 *
 * Overlays preserved from the earlier version: P&L band, entry marker,
 * target lines (TP/rungs/stop/BE/1H), promotion / exit markers, idle
 * "Scout watching" caption. Target lines that fall outside the tight
 * window render clamped to the edge with an ↑/↓ indicator so the trader
 * still sees WHERE they are relative to the current view.
 *
 * The chart itself is the LIVE market. The overlay caption is honesty-
 * preserved ("Paper · Simulated overlay").
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Candle } from "@/hooks/useCandles";
import { deriveTargetLines, type TargetPosition } from "@/lib/botview/derive";
import { exitReasonLabel } from "@/lib/paper/tradeGrouping";
import {
  capPoints,
  clampTargetToDomain,
  computeYDomain,
  easeDomain,
  windowRecent,
} from "@/lib/botview/window";

export type BotChartPosition = TargetPosition & {
  id: string;
  symbol: string;
  direction: "long" | "short";
  entry_price: number;
  entry_ts: string;
  fills?: Array<{ price: number; qty?: number }> | null;
};

export type BotChartTrade = {
  id: string;
  position_id: string | null;
  exit_price: number | string;
  exit_reason: string;
  closed_at: string;
};

export type BotChartEvent = {
  ts: number; // ms epoch
  kind: "htf_promotion";
};

type ChartPoint = {
  t: number;
  close: number;
  bandHigh: number;
  bandLow: number;
};

const POSITIVE = "#14F195";
const NEGATIVE = "#ff5c8a";
const PURPLE = "#9945FF";

/** Trailing minutes of price data drawn in the live window. Owner default
 *  widened from ~8m to ~90m so ~1.5h of context is visible without losing
 *  the auto-scaled Y-axis or smooth updates. */
const WINDOW_MINUTES = 90;
/** Max points held on the visible line (perf cap). */
const MAX_POINTS = 600;
/** Onixus hot-blue token — subtle price/time gridlines. */
const GRID_BLUE = "var(--onixus-hot-blue, #4EA8FF)";

export function PositionBotChart({
  symbol,
  candles,
  livePrice,
  livePriceTs,
  position,
  trades = [],
  events = [],
  watchingLabel,
  height = 340,
}: {
  symbol: string;
  candles: Candle[];
  livePrice?: number | null;
  livePriceTs?: number | null;
  position: BotChartPosition | null;
  trades?: BotChartTrade[];
  events?: BotChartEvent[];
  watchingLabel?: string;
  height?: number;
}) {
  // 1) Build the full trailing point stream (candle closes + latest tick),
  //    then window it to the last WINDOW_MINUTES so the view zooms in.
  //    We also buffer sub-candle live ticks so the line moves on every
  //    ApeX refresh even when no new candle closed.
  const tickBufRef = useRef<Array<{ t: number; close: number }>>([]);
  const lastTickTsRef = useRef<number | null>(null);

  useEffect(() => {
    if (livePrice == null || !Number.isFinite(livePrice)) return;
    const ts = livePriceTs ?? Date.now();
    if (lastTickTsRef.current != null && ts <= lastTickTsRef.current) return;
    lastTickTsRef.current = ts;
    const buf = tickBufRef.current;
    buf.push({ t: ts, close: livePrice });
    // Drop anything older than the window (with slack) to bound memory.
    const cutoff = ts - (WINDOW_MINUTES + 2) * 60_000;
    while (buf.length && buf[0].t < cutoff) buf.shift();
  }, [livePrice, livePriceTs]);

  const priceSeries = useMemo(() => {
    const merged: Array<{ t: number; close: number }> = candles.map((c) => ({
      t: c.openTime,
      close: c.close,
    }));
    // Append buffered live ticks after the last candle close so intra-
    // candle motion is visible.
    const lastCandleT = merged.length ? merged[merged.length - 1].t : 0;
    for (const p of tickBufRef.current) {
      if (p.t > lastCandleT) merged.push(p);
    }
    const windowed = windowRecent(merged, WINDOW_MINUTES);
    return capPoints(windowed, MAX_POINTS);
    // include livePrice/livePriceTs so a fresh tick re-flows the memo
  }, [candles, livePrice, livePriceTs]);

  // 2) Auto-scaled Y domain from the visible window, eased frame-to-frame
  //    so the axis doesn't jitter on every incoming tick.
  const targetDomain = useMemo<[number, number]>(() => {
    const closes = priceSeries.map((p) => p.close);
    if (position) {
      // Include entry so it's always visible inside the tight window.
      const entry = Number(position.entry_price);
      if (Number.isFinite(entry)) closes.push(entry);
    }
    return computeYDomain(closes);
  }, [priceSeries, position]);

  const [yDomain, setYDomain] = useState<[number, number]>(targetDomain);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    // Ease current domain toward target across a few animation frames.
    let cancelled = false;
    const step = () => {
      if (cancelled) return;
      setYDomain((prev) => {
        const next = easeDomain(prev, targetDomain, 0.35);
        const done =
          Math.abs(next[0] - targetDomain[0]) < 1e-6 &&
          Math.abs(next[1] - targetDomain[1]) < 1e-6;
        if (!done) rafRef.current = requestAnimationFrame(step);
        return done ? targetDomain : next;
      });
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [targetDomain]);

  const { data, positive, latestClose } = useMemo(() => {
    if (priceSeries.length === 0) {
      return { data: [] as ChartPoint[], positive: true, latestClose: 0 };
    }
    const last = priceSeries[priceSeries.length - 1].close;
    if (!position) {
      const pts: ChartPoint[] = priceSeries.map((p) => ({
        t: p.t,
        close: p.close,
        bandHigh: p.close,
        bandLow: p.close,
      }));
      return { data: pts, positive: true, latestClose: last };
    }
    const entry = Number(position.entry_price);
    const isLong = position.direction === "long";
    const pts: ChartPoint[] = priceSeries.map((p) => ({
      t: p.t,
      close: p.close,
      bandHigh: Math.max(entry, p.close),
      bandLow: Math.min(entry, p.close),
    }));
    const pos = isLong ? last >= entry : last <= entry;
    return { data: pts, positive: pos, latestClose: last };
  }, [priceSeries, position]);

  const rawTargetLines = useMemo(
    () => (position ? deriveTargetLines(position) : []),
    [position],
  );

  // Clamp target lines to the visible y-domain; out-of-view ones still
  // render at the edge with an ↑/↓ indicator so the trader knows they
  // exist above or below the current window.
  const targetLines = useMemo(
    () =>
      rawTargetLines.map((tl) => {
        const c = clampTargetToDomain(tl.price, yDomain);
        return { ...tl, clamped: c };
      }),
    [rawTargetLines, yDomain],
  );

  const bandColor = positive ? POSITIVE : NEGATIVE;
  const posTrades = position ? trades.filter((t) => t.position_id === position.id) : [];
  const rungFills = position?.fills?.slice(1) ?? [];
  const promoted = !!position?.promoted;
  const entry = position ? Number(position.entry_price) : null;
  const entryTs = position ? new Date(position.entry_ts).getTime() : null;
  const leadingPoint = data.length ? data[data.length - 1] : null;

  return (
    <div className="relative">
      {/* Overlay caption — always visible while Bot View is active */}
      <div className="pointer-events-none absolute right-3 top-2 z-10 rounded-full bg-black/70 px-2.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-white/80">
        Paper · Simulated overlay
      </div>
      {!position && watchingLabel && (
        <div className="pointer-events-none absolute left-3 top-2 z-10 rounded-full bg-black/70 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/70">
          {watchingLabel}
        </div>
      )}
      {position && (
        <div
          className="pointer-events-none absolute left-3 top-2 z-10 rounded-full bg-black/70 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider tabular-nums"
          style={{ color: bandColor }}
        >
          {position.direction.toUpperCase()} · entry {entry?.toFixed(4)} · mark{" "}
          {latestClose.toFixed(4)}
          {promoted ? " · RUNNER" : ""}
        </div>
      )}

      <div style={{ width: "100%", height }}>
        <ResponsiveContainer>
          <ComposedChart data={data} margin={{ top: 24, right: 68, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`pnl-${position?.id ?? symbol}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={bandColor} stopOpacity={0.35} />
                <stop offset="100%" stopColor={bandColor} stopOpacity={0.05} />
              </linearGradient>
              <linearGradient id={`live-glow-${symbol}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={PURPLE} stopOpacity={0.28} />
                <stop offset="100%" stopColor={PURPLE} stopOpacity={0} />
              </linearGradient>
            </defs>
            {/* Subtle price grid in Onixus hot-blue — sits behind the price
                line so it never competes for attention. */}
            <CartesianGrid
              stroke={GRID_BLUE}
              strokeOpacity={0.14}
              strokeDasharray="2 4"
              vertical
              horizontal
            />

            <XAxis
              dataKey="t"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(v) =>
                new Date(v as number).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })
              }
              stroke="rgba(255,255,255,0.25)"
              fontSize={10}
              minTickGap={50}
            />
            <YAxis
              domain={yDomain}
              allowDataOverflow
              stroke="rgba(255,255,255,0.25)"
              fontSize={10}
              tickFormatter={(v) => Number(v).toFixed(2)}
              width={68}
              orientation="right"
            />
            <Tooltip
              contentStyle={{
                background: "#0a0a0a",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 10,
                fontSize: 12,
              }}
              labelFormatter={(v) => new Date(v as number).toLocaleString()}
              formatter={(v, name) => [Number(v).toFixed(4), name]}
            />

            {/* Faint glow trail under the live line so motion reads even on small moves */}
            <Area
              type="monotone"
              dataKey="close"
              stroke="none"
              fill={`url(#live-glow-${symbol})`}
              activeDot={false}
              isAnimationActive={false}
              name=""
              legendType="none"
            />

            {/* P&L band — high shaded, low masked to black so the band sits between entry and price */}
            {position && (
              <>
                <Area
                  type="monotone"
                  dataKey="bandHigh"
                  stroke="none"
                  fill={`url(#pnl-${position.id})`}
                  activeDot={false}
                  isAnimationActive
                  animationDuration={250}
                  name="Open P&L"
                />
                <Area
                  type="monotone"
                  dataKey="bandLow"
                  stroke="none"
                  fill="#000"
                  fillOpacity={1}
                  activeDot={false}
                  isAnimationActive={false}
                  legendType="none"
                  name=""
                />
              </>
            )}

            {/* Smooth live price line — monotone curve, short animation for glide feel */}
            <Line
              type="monotone"
              dataKey="close"
              stroke={PURPLE}
              strokeWidth={2}
              dot={false}
              isAnimationActive
              animationDuration={250}
              animationEasing="ease-out"
              name="Price"
            />

            {/* Pulsing leading-edge "live" dot */}
            {leadingPoint && (
              <ReferenceDot
                x={leadingPoint.t}
                y={leadingPoint.close}
                r={4}
                shape={(props: unknown) => {
                  const p = props as { cx?: number; cy?: number };
                  if (p.cx == null || p.cy == null) return <g />;
                  return (
                    <g>
                      <circle cx={p.cx} cy={p.cy} r={3.5} fill={PURPLE} stroke="#fff" strokeWidth={1} />
                      <circle cx={p.cx} cy={p.cy} r={6} fill="none" stroke={PURPLE} strokeOpacity={0.75}>
                        <animate attributeName="r" from="4" to="14" dur="1.4s" repeatCount="indefinite" />
                        <animate attributeName="stroke-opacity" from="0.75" to="0" dur="1.4s" repeatCount="indefinite" />
                      </circle>
                    </g>
                  );
                }}
              />
            )}

            {/* Entry line — clamp to visible domain */}
            {position && entry != null && (() => {
              const c = clampTargetToDomain(entry, yDomain);
              const label = c.inView
                ? "ENTRY"
                : c.side === "above"
                  ? `↑ ENTRY ${entry.toFixed(2)}`
                  : `↓ ENTRY ${entry.toFixed(2)}`;
              return (
                <ReferenceLine
                  y={c.price}
                  stroke="rgba(255,255,255,0.35)"
                  strokeDasharray="4 4"
                  label={{
                    value: label,
                    position: "right",
                    fill: "rgba(255,255,255,0.6)",
                    fontSize: 10,
                  }}
                />
              );
            })()}

            {/* Target lines: TP · STOP · RUNG N · BE STOP · 1H STRUCTURE
                (out-of-view → clamped to edge with ↑/↓ indicator) */}
            {targetLines.map((tl) => {
              const label = tl.clamped.inView
                ? tl.label
                : tl.clamped.side === "above"
                  ? `↑ ${tl.label} ${tl.clamped.original.toFixed(2)}`
                  : `↓ ${tl.label} ${tl.clamped.original.toFixed(2)}`;
              return (
                <ReferenceLine
                  key={`${tl.kind}-${tl.label}-${tl.clamped.original}`}
                  y={tl.clamped.price}
                  stroke={tl.color}
                  strokeDasharray={tl.clamped.inView ? "2 4" : "1 3"}
                  strokeOpacity={tl.clamped.inView ? 1 : 0.7}
                  label={{ value: label, position: "right", fill: tl.color, fontSize: 10 }}
                />
              );
            })}

            {/* Entry marker */}
            {position && entry != null && entryTs != null && data.length > 0 && entryTs >= data[0].t && (
              <ReferenceDot
                x={entryTs}
                y={entry}
                r={4}
                fill={PURPLE}
                stroke="#fff"
                strokeWidth={1}
              />
            )}

            {/* Rung fill markers (approximate x — use fill index near tail) */}
            {position &&
              rungFills.map((f, i) => (
                <ReferenceDot
                  key={`rung-${i}`}
                  x={data[Math.max(0, data.length - 1 - i)]?.t ?? entryTs ?? data[0]?.t}
                  y={Number(f.price)}
                  r={3}
                  fill={PURPLE}
                  stroke="#fff"
                  strokeWidth={1}
                />
              ))}

            {/* HTF promotion markers — the "became a runner" moment */}
            {position &&
              events
                .filter((e) => e.kind === "htf_promotion")
                .map((e, i) => (
                  <ReferenceDot
                    key={`promo-${i}`}
                    x={e.ts}
                    y={entry ?? 0}
                    r={5}
                    fill="#e8b73a"
                    stroke="#fff"
                    strokeWidth={1}
                    label={{
                      value: "PROMOTED",
                      position: "top",
                      fill: "#e8b73a",
                      fontSize: 9,
                    }}
                  />
                ))}

            {/* Exit markers labeled with the exit reason */}
            {posTrades.map((t) => (
              <ReferenceDot
                key={`exit-${t.id}`}
                x={new Date(t.closed_at).getTime()}
                y={Number(t.exit_price)}
                r={4}
                fill={NEGATIVE}
                stroke="#fff"
                strokeWidth={1}
                label={{
                  value: exitReasonLabel(t.exit_reason).label,
                  position: "top",
                  fill: NEGATIVE,
                  fontSize: 9,
                }}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
