// Recharts-based candlestick chart. Uses ComposedChart with a custom Bar
// shape to render OHLC candles. Overlays:
//   - horizontal price lines for entry / stop-loss / take-profits
//   - long/short direction tint on latest signal
//   - current price line
// All overlays are optional — pass only what the caller has.

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Candle } from "@/hooks/useCandles";

export type CandleOverlay = {
  side?: "long" | "short" | null;
  entry?: number | null;
  entryLow?: number | null;
  entryHigh?: number | null;
  stopLoss?: number | null;
  takeProfits?: number[] | null;
};

type CandleDatum = Candle & { hlRange: [number, number]; ocRange: [number, number]; direction: 1 | -1 };

function toData(candles: Candle[]): CandleDatum[] {
  return candles.map((c) => ({
    ...c,
    hlRange: [c.low, c.high] as [number, number],
    ocRange: [Math.min(c.open, c.close), Math.max(c.open, c.close)] as [number, number],
    direction: c.close >= c.open ? 1 : -1,
  }));
}

// Custom shape that draws the wick (thin) and body (thick) for a candle.
// Recharts passes computed x/y/width/height for the [low,high] range Bar.
function CandleShape(props: { x?: number; y?: number; width?: number; height?: number; payload?: CandleDatum }) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = props;
  if (!payload) return null;
  const isUp = payload.direction === 1;
  const color = isUp ? "hsl(158 84% 52%)" : "hsl(0 84% 62%)";
  const wickX = Number(x) + Number(width) / 2;
  // Body: derive y/height from open-close within the low-high band.
  const range = payload.high - payload.low || 1;
  const bodyTopVal = Math.max(payload.open, payload.close);
  const bodyBotVal = Math.min(payload.open, payload.close);
  const bodyY = Number(y) + ((payload.high - bodyTopVal) / range) * Number(height);
  const bodyH = Math.max(1, ((bodyTopVal - bodyBotVal) / range) * Number(height));
  const bodyW = Math.max(2, Number(width) * 0.7);
  const bodyX = Number(x) + (Number(width) - bodyW) / 2;
  return (
    <g>
      <line
        x1={wickX}
        x2={wickX}
        y1={Number(y)}
        y2={Number(y) + Number(height)}
        stroke={color}
        strokeWidth={1}
        opacity={0.85}
      />
      <rect x={bodyX} y={bodyY} width={bodyW} height={bodyH} fill={color} opacity={0.95} />
    </g>
  );
}

function fmtPrice(n: number): string {
  if (!isFinite(n)) return "—";
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}
function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCHours().toString().padStart(2, "0")}:${d.getUTCMinutes().toString().padStart(2, "0")}`;
}

export function CandlestickChart({
  candles,
  overlay,
  height = 380,
}: {
  candles: Candle[];
  overlay?: CandleOverlay;
  height?: number;
}) {
  const data = useMemo(() => toData(candles), [candles]);
  const lastPrice = candles.length ? candles[candles.length - 1].close : null;

  if (!candles.length) {
    return (
      <div
        className="flex h-full min-h-[280px] items-center justify-center rounded-xl border border-border/40 bg-inset"
        style={{ height }}
      >
        <span className="text-sm text-muted-foreground">Loading market data…</span>
      </div>
    );
  }

  const sideTint =
    overlay?.side === "long"
      ? "hsl(158 84% 52% / 0.06)"
      : overlay?.side === "short"
        ? "hsl(0 84% 62% / 0.06)"
        : undefined;

  return (
    <div className="relative w-full" style={{ height }}>
      {sideTint ? (
        <div
          className="pointer-events-none absolute inset-0 rounded-xl"
          style={{ background: sideTint }}
        />
      ) : null}
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 10, right: 60, left: 0, bottom: 4 }}>
          <CartesianGrid stroke="hsl(240 9% 20% / 0.5)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="openTime"
            tickFormatter={fmtTime}
            tick={{ fill: "hsl(215 20% 65%)", fontSize: 10 }}
            axisLine={{ stroke: "hsl(240 9% 26%)" }}
            tickLine={false}
            minTickGap={30}
          />
          <YAxis
            orientation="right"
            domain={["auto", "auto"]}
            tickFormatter={fmtPrice}
            tick={{ fill: "hsl(215 20% 65%)", fontSize: 10 }}
            axisLine={{ stroke: "hsl(240 9% 26%)" }}
            tickLine={false}
            width={56}
          />
          <Tooltip
            cursor={{ stroke: "hsl(215 20% 65% / 0.4)", strokeDasharray: "2 4" }}
            contentStyle={{
              background: "hsl(225 12% 10%)",
              border: "1px solid hsl(240 9% 26%)",
              borderRadius: 8,
              fontSize: 12,
              color: "hsl(210 20% 96%)",
            }}
            labelFormatter={(v) => new Date(v as number).toISOString().replace("T", " ").slice(0, 16) + " UTC"}
            formatter={(_val, _name, item) => {
              const p = item?.payload as CandleDatum | undefined;
              if (!p) return "—";
              return [
                `O ${fmtPrice(p.open)}  H ${fmtPrice(p.high)}  L ${fmtPrice(p.low)}  C ${fmtPrice(p.close)}`,
                "OHLC",
              ] as [string, string];
            }}
          />
          {/* Full high-low range bar carries the candle. */}
          <Bar dataKey="hlRange" shape={<CandleShape />} isAnimationActive={false} />

          {overlay?.entry != null ? (
            <ReferenceLine
              y={overlay.entry}
              stroke="hsl(217 91% 60%)"
              strokeDasharray="4 4"
              label={{ value: `Entry ${fmtPrice(overlay.entry)}`, fill: "hsl(217 91% 70%)", fontSize: 10, position: "right" }}
            />
          ) : null}
          {overlay?.entryLow != null && overlay?.entryHigh != null ? (
            <>
              <ReferenceLine y={overlay.entryLow} stroke="hsl(217 91% 60% / 0.6)" strokeDasharray="2 4" />
              <ReferenceLine y={overlay.entryHigh} stroke="hsl(217 91% 60% / 0.6)" strokeDasharray="2 4" />
            </>
          ) : null}
          {overlay?.stopLoss != null ? (
            <ReferenceLine
              y={overlay.stopLoss}
              stroke="hsl(0 84% 62%)"
              strokeDasharray="6 3"
              label={{ value: `SL ${fmtPrice(overlay.stopLoss)}`, fill: "hsl(0 84% 72%)", fontSize: 10, position: "right" }}
            />
          ) : null}
          {(overlay?.takeProfits ?? []).map((tp, i) => (
            <ReferenceLine
              key={`tp-${i}`}
              y={tp}
              stroke="hsl(158 84% 52%)"
              strokeDasharray="6 3"
              label={{ value: `TP${i + 1} ${fmtPrice(tp)}`, fill: "hsl(158 84% 62%)", fontSize: 10, position: "right" }}
            />
          ))}
          {lastPrice != null ? (
            <ReferenceLine
              y={lastPrice}
              stroke="hsl(210 20% 96% / 0.6)"
              strokeDasharray="1 3"
              label={{ value: fmtPrice(lastPrice), fill: "hsl(210 20% 96%)", fontSize: 10, position: "right" }}
            />
          ) : null}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// Compact volume histogram, meant to sit directly beneath the candles.
export function VolumeChart({ candles, height = 80 }: { candles: Candle[]; height?: number }) {
  const data = useMemo(
    () => candles.map((c) => ({ openTime: c.openTime, volume: c.volume, up: c.close >= c.open })),
    [candles],
  );
  if (!candles.length) return null;
  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 0, right: 60, left: 0, bottom: 0 }}>
          <XAxis dataKey="openTime" hide />
          <YAxis hide />
          <Tooltip
            cursor={false}
            contentStyle={{
              background: "hsl(225 12% 10%)",
              border: "1px solid hsl(240 9% 26%)",
              borderRadius: 8,
              fontSize: 11,
              color: "hsl(210 20% 96%)",
            }}
            formatter={(v) => [(v as number).toFixed(2), "Volume"] as [string, string]}
            labelFormatter={(v) => new Date(v as number).toISOString().slice(11, 16) + " UTC"}
          />
          <Bar
            dataKey="volume"
            shape={(props: unknown) => {
              const p = props as { x: number; y: number; width: number; height: number; payload: { up: boolean } };
              const color = p.payload.up ? "hsl(158 84% 52% / 0.55)" : "hsl(0 84% 62% / 0.55)";
              return <rect x={p.x} y={p.y} width={Math.max(1, p.width * 0.7)} height={p.height} fill={color} />;
            }}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
