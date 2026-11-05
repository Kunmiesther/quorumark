// Bot-view LINE chart with CONTINUOUS wall-clock scrolling.
//
// Motion approach:
//   • A single requestAnimationFrame loop advances a wall-clock "now" ref.
//     The X domain is derived from now every frame:
//       xMax = now + smallLead, xMin = now - windowMs
//     so the tape slides left continuously even when no new tick arrives.
//   • Y domain eases toward the visible min/max over ~400ms via critically-
//     damped LERP — no snap when a large move enters the window.
//   • The line is extended to the right edge by appending a synthetic
//     "leading" point at (now, lastPrice) so the pulsing dot always sits
//     at the right edge and rides vertically with price.
//   • React state is updated once per frame with a tiny `{ now, y }` object
//     scoped to this component — parent tree is never re-rendered. When
//     idle (target === current) the loop still runs at rAF cadence but only
//     the internal domain state changes.
//   • prefers-reduced-motion: rAF loop is disabled; instead the domain is
//     refreshed once every 2s so the axis still ticks forward without
//     motion.
//
// Everything else preserved: line-only rendering (no candles), BOS coloring
// (hot-blue neutral/bullish, purple bearish), hot-blue gridlines, dark
// background, per-leg overlays clipped to plot, mark-price pill.
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Candle } from "@/hooks/useCandles";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { formatTpDistance, type TpProximityResult } from "@/lib/trade/tpProximity";
import { BotWorldJourney } from "./BotWorldJourney";

export type BotRegime = "bullish" | "bearish" | "neutral";

export type LegOverlay = {
  key: string;
  label: string;
  color: string;
  dimmed?: boolean;
  side?: "long" | "short" | null;
  entry?: number | null;
  entryLow?: number | null;
  entryHigh?: number | null;
  stop?: number | null;
  invalidation?: number | null;
  tps?: number[] | null;
  rungs?: number[] | null;
  breakout?: number | null;
  avgEntry?: number | null;
};

export type BotLineOverlay = {
  side?: "long" | "short" | null;
  entry?: number | null;
  entryLow?: number | null;
  entryHigh?: number | null;
  stopLoss?: number | null;
  takeProfits?: number[] | null;
  rungs?: number[] | null;
  /** Per-leg overlays (Vanguard/Accumulator/Sweep/Hunter/Arbiter/Scout). */
  legs?: LegOverlay[] | null;
};

const COLOR: Record<BotRegime, string> = {
  bullish: "var(--onixus-hot-blue)", // #4EA8FF
  bearish: "var(--onixus-purple)",   // #9945FF
  neutral: "var(--onixus-hot-blue)", // default line = hot blue
};

function fmtPrice(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1000) return v.toFixed(1);
  if (v >= 1) return v.toFixed(3);
  return v.toFixed(5);
}
function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCHours().toString().padStart(2, "0")}:${d
    .getUTCMinutes()
    .toString()
    .padStart(2, "0")}`;
}

export function normalizeRegime(raw: string | null | undefined): BotRegime {
  const r = (raw ?? "").toString().toLowerCase();
  if (r.includes("bull") || r === "up" || r === "long") return "bullish";
  if (r.includes("bear") || r === "down" || r === "short") return "bearish";
  return "neutral";
}

const MAX_POINTS = 300;
/** Small lead past `now` so the leading dot never touches the right edge. */
const LEAD_MS_FRAC = 0.02; // 2% of window

/** Framerate-independent-ish lerp. */
function lerp(from: number, to: number, k: number): number {
  return from + (to - from) * k;
}

export function BotLineChart({
  candles,
  overlay,
  regime = "neutral",
  height = 340,
  tailFraction = 0.2,
  windowMinutes = 8,
  tpTracker = null,
}: {
  candles: Candle[];
  overlay?: BotLineOverlay;
  regime?: BotRegime;
  height?: number;
  tailFraction?: number;
  windowMinutes?: number;
  /** Deterministic next-TP proximity, computed by the desk. */
  tpTracker?: TpProximityResult | null;
}) {
  const reduced = useReducedMotion();
  const windowMs = windowMinutes * 60_000;
  const leadMs = Math.max(2_000, windowMs * LEAD_MS_FRAC);


  // Stable candle-derived series (only recomputed when candles change).
  const { rows, latestPrice, latestT } = useMemo(() => {
    if (!candles.length) {
      return { rows: [] as Array<{ t: number; price: number }>, latestPrice: null as number | null, latestT: 0 };
    }
    let series = candles.slice();
    if (series.length > MAX_POINTS) {
      const step = Math.ceil(series.length / MAX_POINTS);
      series = series.filter((_, i) => i % step === 0 || i === series.length - 1);
    }
    const r = series.map((c) => ({ t: c.openTime, price: c.close }));
    const last = r[r.length - 1];
    return { rows: r, latestPrice: last.price, latestT: last.t };
  }, [candles]);

  // Wall-clock driven state; single source of truth updated per rAF frame.
  const [tick, setTick] = useState<number>(() => Date.now());
  const nowRef = useRef<number>(Date.now());

  // Eased Y domain (targets derived every frame from the visible window).
  const yRef = useRef<{ min: number; max: number }>({ min: 0, max: 1 });
  const [yDom, setYDom] = useState<{ min: number; max: number }>({ min: 0, max: 1 });

  // rAF loop — advances now, eases Y, and pushes to state ONCE per frame.
  useEffect(() => {
    if (reduced) {
      // Reduced-motion: refresh domain every 2s, no per-frame animation.
      const id = window.setInterval(() => {
        nowRef.current = Date.now();
        setTick(nowRef.current);
      }, 2000);
      return () => window.clearInterval(id);
    }
    let raf = 0;
    const step = () => {
      nowRef.current = Date.now();
      // Compute visible Y target from rows inside the sliding window.
      const xMin = nowRef.current - windowMs;
      let vMin = Infinity;
      let vMax = -Infinity;
      for (let i = rowsRef.current.length - 1; i >= 0; i--) {
        const r = rowsRef.current[i];
        if (r.t < xMin) break;
        if (r.price < vMin) vMin = r.price;
        if (r.price > vMax) vMax = r.price;
      }
      // Include the leading (live) price.
      const lp = latestPriceRef.current;
      if (lp != null) {
        if (lp < vMin) vMin = lp;
        if (lp > vMax) vMax = lp;
      }
      if (Number.isFinite(vMin) && Number.isFinite(vMax)) {
        const pad = Math.max((vMax - vMin) * 0.1, Math.abs(vMax) * 0.0006);
        const tMin = vMin - pad;
        const tMax = vMax + pad;
        // ~400ms critically-damped: k≈0.14 at 60fps.
        const cur = yRef.current;
        const next = { min: lerp(cur.min, tMin, 0.14), max: lerp(cur.max, tMax, 0.14) };
        yRef.current = next;
      }
      setTick(nowRef.current);
      setYDom(yRef.current);
      raf = requestAnimationFrame(step);
    };
    // Seed Y domain immediately so first paint isn't [0,1].
    if (rowsRef.current.length) {
      const xMin = Date.now() - windowMs;
      const vis = rowsRef.current.filter((r) => r.t >= xMin).map((r) => r.price);
      if (latestPriceRef.current != null) vis.push(latestPriceRef.current);
      if (vis.length) {
        const mn = Math.min(...vis);
        const mx = Math.max(...vis);
        const pad = Math.max((mx - mn) * 0.1, Math.abs(mx) * 0.0006);
        yRef.current = { min: mn - pad, max: mx + pad };
        setYDom(yRef.current);
      }
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [reduced, windowMs]);

  // Refs so the rAF loop reads the freshest data without restarting.
  const rowsRef = useRef(rows);
  const latestPriceRef = useRef<number | null>(latestPrice);
  useEffect(() => {
    rowsRef.current = rows;
    latestPriceRef.current = latestPrice;
  }, [rows, latestPrice]);

  // Build the render data ONCE per frame from the driven `tick`.
  const { data, xMin, xMax } = useMemo(() => {
    const now = tick;
    const xmn = now - windowMs;
    const xmx = now + leadMs;
    // Only include points inside window (drop older to keep splitting cheap).
    const inWin = rows.filter((r) => r.t >= xmn - 1_000);
    // Split older vs tail for two-tone stroke.
    const split = Math.max(
      0,
      Math.floor(inWin.length * (1 - Math.min(0.95, Math.max(0.05, tailFraction)))),
    );
    const merged = inWin.map((d, i) => ({
      t: d.t,
      price: d.price,
      priceOlder: i <= split ? d.price : null,
      priceTail: i >= split ? d.price : null,
    }));
    // Append a synthetic "leading" point at now with the latest price so
    // the tail line + pulsing dot ride the right edge.
    if (latestPrice != null && (merged.length === 0 || now > merged[merged.length - 1].t)) {
      merged.push({
        t: now,
        price: latestPrice,
        priceOlder: null,
        priceTail: latestPrice,
      });
    }
    return { data: merged, xMin: xmn, xMax: xmx };
  }, [tick, rows, latestPrice, windowMs, leadMs, tailFraction]);

  // Vertical gridlines synthesized so they SCROLL with time even in flat
  // price. We place ticks on round minute boundaries within the window.
  const timeTicks = useMemo(() => {
    const stepMs = Math.max(30_000, Math.round(windowMs / 8 / 30_000) * 30_000);
    const ticks: number[] = [];
    const start = Math.ceil(xMin / stepMs) * stepMs;
    for (let t = start; t <= xMax; t += stepMs) ticks.push(t);
    return ticks;
  }, [xMin, xMax, windowMs]);

  const regimeColor = COLOR[regime];

  if (!candles.length) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-white/10 bg-black"
        style={{ height }}
        data-testid="bot-line-chart"
      >
        <span className="text-sm text-white/50">Loading market data…</span>
      </div>
    );
  }

  // Leading-edge marker.
  //
  // Normally it follows the chart theme (Solana teal/purple comet). As price
  // closes on the next unhit TP the head transitions to a glowing GOLD orb:
  //   approach (<15% of the entry->TP span remaining) -> gradual gold fade
  //   imminent (<5% remaining)                        -> gold + soft pulse
  //   hit                                             -> stable gold, no motion
  // `goldMix` is a continuous 0..1 ramp, so the colour never snaps or flashes.
  const goldMix = tpTracker?.goldMix ?? 0;
  const goldPhase = tpTracker?.phase ?? "idle";
  // Pulse only when the deterministic rule says so AND motion is allowed.
  const goldPulse = Boolean(tpTracker?.pulse) && !reduced;

  const renderTailDot = (props: any) => {
    if (props?.index !== data.length - 1) return <g key={`d-${props?.index}`} />;
    const { cx, cy } = props;
    const goldOn = goldMix > 0.001;
    // Cross-fade: theme comet fades out exactly as the gold orb fades in.
    const themeOpacity = 1 - goldMix;
    return (
      <g key="botline-comet" style={{ pointerEvents: "none" }} data-tp-phase={goldPhase}>
        {/* Theme comet — fire trail + halos. */}
        <g opacity={themeOpacity}>
          <ellipse
            cx={cx - 22}
            cy={cy}
            rx={26}
            ry={4}
            fill="url(#botline-comet-fire)"
            opacity={0.85}
            className="botline-comet-trail"
          />
          <circle cx={cx} cy={cy} r={5} fill="var(--onixus-purple)" className="botline-mark-pulse" />
          <circle cx={cx} cy={cy} r={9} fill="url(#botline-comet-head)" opacity={0.55} />
          <circle cx={cx} cy={cy} r={5} fill="url(#botline-comet-head)" />
        </g>
        {/* Gold TP-proximity orb. */}
        {goldOn ? (
          <g opacity={goldMix} data-testid="tp-gold-orb">
            <circle
              cx={cx}
              cy={cy}
              r={14}
              fill="url(#botline-gold-head)"
              opacity={0.45}
              className={goldPulse ? "botline-gold-pulse" : undefined}
            />
            <circle cx={cx} cy={cy} r={8} fill="url(#botline-gold-head)" opacity={0.9} />
            <circle cx={cx} cy={cy} r={4.5} fill="#FFD24A" />
          </g>
        ) : null}
        {/* Bright core sits above both states. */}
        <circle cx={cx} cy={cy} r={2} fill="#ffffff" />
      </g>
    );
  };

  return (
    <div
      className="relative w-full overflow-hidden rounded-xl bg-black"
      style={{ height, background: "#000" }}
      data-testid="bot-line-chart"
    >
      {/* Decorative cinematic world strip — behind Recharts, transparent to
          pointer events, dimmed by a near-black readability scrim. */}
      <BotWorldJourney />
      <TpDistanceChip tracker={tpTracker} />
      <div className="relative h-full w-full" style={{ zIndex: 1 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 10, right: 64, left: 0, bottom: 4 }}>
          <defs>
            {/* Solana-fire gradient used by both the comet head halo and the
                trailing fire streak. */}
            <linearGradient id="botline-comet-fire" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%"   stopColor="#14F195" stopOpacity="0" />
              <stop offset="45%"  stopColor="#14F195" stopOpacity="0.75" />
              <stop offset="80%"  stopColor="#9945FF" stopOpacity="0.95" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="1" />
            </linearGradient>
            <radialGradient id="botline-gold-head" cx="50%" cy="50%" r="50%">
              <stop offset="0%"   stopColor="#FFF6D0" stopOpacity="1" />
              <stop offset="40%"  stopColor="#FFD24A" stopOpacity="0.95" />
              <stop offset="100%" stopColor="#B8860B" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="botline-comet-head" cx="50%" cy="50%" r="50%">
              <stop offset="0%"   stopColor="#ffffff" stopOpacity="1" />
              <stop offset="45%"  stopColor="#9945FF" stopOpacity="0.85" />
              <stop offset="100%" stopColor="#14F195" stopOpacity="0" />
            </radialGradient>
            {/* Full-length Solana gradient stroke — teal ⇄ purple flowing. */}
            <linearGradient id="botline-comet-stroke" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%"   stopColor="#14F195" />
              <stop offset="35%"  stopColor="#9945FF" />
              <stop offset="70%"  stopColor="#14F195" />
              <stop offset="100%" stopColor="#9945FF">
                <animate attributeName="stop-color"
                  values="#9945FF;#14F195;#9945FF"
                  dur="3.2s" repeatCount="indefinite" />
              </stop>
              <animate attributeName="x1" values="-1;0;-1" dur="6s" repeatCount="indefinite" />
              <animate attributeName="x2" values="0;1;0" dur="6s" repeatCount="indefinite" />
            </linearGradient>
          </defs>
          <CartesianGrid
            stroke="var(--onixus-hot-blue)"
            strokeOpacity={0.14}
            strokeDasharray="2 4"
            fill="transparent"
            horizontal
            vertical={false}
          />
          {/* Time-scrolling vertical gridlines (synthesized so motion is
              visible in flat price too). */}
          {timeTicks.map((t) => (
            <ReferenceLine
              key={`vg-${t}`}
              x={t}
              stroke="var(--onixus-hot-blue)"
              strokeOpacity={0.14}
              strokeDasharray="2 4"
              ifOverflow="hidden"
            />
          ))}
          <XAxis
            type="number"
            dataKey="t"
            domain={[xMin, xMax]}
            allowDataOverflow
            ticks={timeTicks}
            tickFormatter={fmtTime}
            tick={{ fill: "rgba(230,232,240,0.55)", fontSize: 10 }}
            axisLine={{ stroke: "rgba(255,255,255,0.12)" }}
            tickLine={false}
            minTickGap={30}
          />
          <YAxis
            orientation="right"
            type="number"
            domain={[yDom.min, yDom.max]}
            allowDataOverflow
            tickFormatter={fmtPrice}
            tick={{ fill: "rgba(230,232,240,0.55)", fontSize: 10 }}
            axisLine={{ stroke: "rgba(255,255,255,0.12)" }}
            tickLine={false}
            width={56}
          />
          <Tooltip
            cursor={{ stroke: "rgba(255,255,255,0.25)", strokeDasharray: "2 4" }}
            contentStyle={{
              background: "#000",
              border: "1px solid rgba(255,255,255,0.14)",
              borderRadius: 8,
              fontSize: 12,
              color: "rgba(230,232,240,0.95)",
            }}
            labelFormatter={(v) =>
              new Date(v as number).toISOString().replace("T", " ").slice(0, 16) + " UTC"
            }
            formatter={(_v, _n, item) => {
              const p = item?.payload as { price?: number } | undefined;
              return [p?.price != null ? fmtPrice(p.price) : "—", "PRICE"] as [string, string];
            }}
          />

          {overlay?.entryLow != null && overlay?.entryHigh != null ? (
            <>
              <ReferenceLine
                y={overlay.entryLow}
                stroke="var(--onixus-hot-blue)"
                strokeOpacity={0.45}
                strokeDasharray="3 5"
                ifOverflow="hidden"
              />
              <ReferenceLine
                y={overlay.entryHigh}
                stroke="var(--onixus-hot-blue)"
                strokeOpacity={0.45}
                strokeDasharray="3 5"
                ifOverflow="hidden"
                label={{
                  value: "ENTRY ZONE",
                  fill: "var(--onixus-hot-blue)",
                  fontSize: 9,
                  position: "insideTopLeft",
                  offset: 4,
                }}
              />
            </>
          ) : overlay?.entry != null ? (
            <ReferenceLine
              y={overlay.entry}
              stroke="var(--onixus-hot-blue)"
              strokeDasharray="4 4"
              ifOverflow="hidden"
              label={{
                value: `Entry ${fmtPrice(overlay.entry)}`,
                fill: "var(--onixus-hot-blue)",
                fontSize: 10,
                position: "insideRight",
              }}
            />
          ) : null}

          {(overlay?.rungs ?? []).map((r, i) => (
            <ReferenceLine
              key={`rung-${i}`}
              y={r}
              stroke={overlay?.side === "short" ? "var(--onixus-red)" : "var(--onixus-hot-blue)"}
              strokeOpacity={0.35}
              strokeDasharray="1 4"
              ifOverflow="hidden"
              label={{
                value: `R${i + 1}`,
                fill: overlay?.side === "short" ? "var(--onixus-red)" : "var(--onixus-hot-blue)",
                fontSize: 9,
                position: "insideLeft",
                offset: 4,
              }}
            />
          ))}

          {/* Per-leg overlays. */}
          {(overlay?.legs ?? []).flatMap((leg) => {
            const op = leg.dimmed ? 0.18 : 0.7;
            const lop = leg.dimmed ? 0.35 : 0.95;
            const lines: ReactElement[] = [];
            const push = (k: string, y: number | null | undefined, tag: string, dash = "4 4") => {
              if (y == null || !Number.isFinite(y)) return;
              lines.push(
                <ReferenceLine
                  key={`${leg.key}-${k}`}
                  y={y}
                  stroke={leg.color}
                  strokeOpacity={op}
                  strokeDasharray={dash}
                  ifOverflow="hidden"
                  label={{
                    value: `${leg.label} · ${tag} ${fmtPrice(y)}`,
                    fill: leg.color,
                    fontSize: 9,
                    fillOpacity: lop,
                    position: "insideLeft",
                    offset: 4,
                  }}
                />,
              );
            };
            push("entry", leg.entry, "ENTRY");
            push("avg", leg.avgEntry, "AVG", "6 2");
            push("stop", leg.stop, "STOP", "6 3");
            push("inv", leg.invalidation, "INV", "2 5");
            push("brk", leg.breakout, "BRK", "8 4");
            push("elow", leg.entryLow, "ZL", "3 5");
            push("ehigh", leg.entryHigh, "ZH", "3 5");
            (leg.tps ?? []).forEach((tp, i) => push(`tp${i}`, tp, `TP${i + 1}`, "6 3"));
            (leg.rungs ?? []).forEach((r, i) => push(`r${i}`, r, `R${i + 1}`, "1 4"));
            return lines;
          })}

          {overlay?.stopLoss != null ? (
            <ReferenceLine
              y={overlay.stopLoss}
              stroke="var(--onixus-red)"
              strokeDasharray="6 3"
              ifOverflow="hidden"
              label={{
                value: `SL ${fmtPrice(overlay.stopLoss)}`,
                fill: "var(--onixus-red)",
                fontSize: 10,
                position: "insideRight",
              }}
            />
          ) : null}
          {(overlay?.takeProfits ?? []).map((tp, i) => (
            <ReferenceLine
              key={`tp-${i}`}
              y={tp}
              stroke="var(--onixus-teal)"
              strokeDasharray="6 3"
              ifOverflow="hidden"
              label={{
                value: `TP${i + 1} ${fmtPrice(tp)}`,
                fill: "var(--onixus-teal)",
                fontSize: 10,
                position: "insideRight",
              }}
            />
          ))}

          {/* Mark-price line tracking the leading edge. */}
          {latestPrice != null ? (
            <ReferenceLine
              y={latestPrice}
              stroke={regimeColor}
              strokeOpacity={0.55}
              strokeDasharray="2 4"
              label={{
                value: `▸ ${fmtPrice(latestPrice)}`,
                fill: regimeColor,
                fontSize: 11,
                position: "insideRight",
                offset: 6,
              }}
            />
          ) : null}

          {/* Single unified price line — full Solana gradient, smoothed, pulsing. */}
          <Line
            type="natural"
            dataKey="price"
            className="botline-tail-pulse"
            stroke="url(#botline-comet-stroke)"
            strokeWidth={3.25}
            strokeOpacity={1}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            dot={renderTailDot}
            activeDot={false}
            isAnimationActive={false}
            connectNulls
          />
          {/* Reference: silence unused var warning for latestT in some builds. */}
          {latestT ? null : null}
        </ComposedChart>
      </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Compact distance-to-next-TP readout. Renders a safe reason when inactive. */
function TpDistanceChip({ tracker }: { tracker: TpProximityResult | null }) {
  if (!tracker) return null;
  const label = formatTpDistance(tracker, fmtPrice);
  const reasonCopy: Record<string, string> = {
    no_position: "NO ACTIVE POSITION",
    no_tp_data: "NO TP DATA",
    all_tps_hit: "ALL TPs HIT",
    stale_price: "PRICE STALE",
    invalid_geometry: "TP GEOMETRY UNAVAILABLE",
  };
  const text = label ?? (tracker.reason ? reasonCopy[tracker.reason] : null);
  if (!text) return null;
  const active = tracker.reason == null;
  const gold = tracker.goldMix > 0.001;
  return (
    <div
      className="pointer-events-none absolute left-3 top-2 z-10 rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-wide"
      data-testid="tp-distance-chip"
      data-tp-phase={tracker.phase}
      style={{
        background: "rgba(0,0,0,0.72)",
        borderColor: gold ? "rgba(255,210,74,0.55)" : "rgba(255,255,255,0.14)",
        color: gold ? "#FFD24A" : active ? "var(--onixus-teal)" : "rgba(230,232,240,0.55)",
      }}
    >
      {active ? "NEXT " : ""}
      {text}
      {active && tracker.progress > 0 ? (
        <span className="ml-2 opacity-70">{Math.round(tracker.progress * 100)}%</span>
      ) : null}
    </div>
  );
}
