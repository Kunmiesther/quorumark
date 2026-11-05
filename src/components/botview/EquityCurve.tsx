/**
 * Account equity curve — smooth monotone area chart.
 *
 * Data source: `paper_trades.pnl_net` cumulated on top of the starting
 * account balance. Read-only, deterministic — no engine writes.
 * Honesty rule: the curve goes DOWN on losses (no clamping).
 */
import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { deriveEquitySeries, type EquityTrade } from "@/lib/botview/derive";

const PURPLE = "#9945FF";

function fmtUsd(n: number) {
  const sign = n < 0 ? "−" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function EquityCurve({
  trades,
  baseEquity,
  height = 180,
}: {
  trades: EquityTrade[];
  baseEquity: number;
  height?: number;
}) {
  const data = useMemo(
    () => deriveEquitySeries(trades, baseEquity, 300),
    [trades, baseEquity],
  );

  const last = data[data.length - 1]?.equity ?? baseEquity;
  const change = last - baseEquity;
  const changePct = baseEquity !== 0 ? (change / baseEquity) * 100 : 0;
  const positive = change >= 0;

  return (
    <div className="rounded-3xl border border-white/5 bg-black/40 p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-white/50">
            Account equity curve
          </div>
          <div className="mt-1 flex items-baseline gap-2 tabular-nums">
            <span className="text-[22px] font-semibold text-white">{fmtUsd(last)}</span>
            <span
              className="text-[12px] font-semibold"
              style={{ color: positive ? "#14F195" : "#ff5c8a" }}
            >
              {positive ? "+" : "−"}
              {fmtUsd(Math.abs(change)).replace(/^[+−]?/, "")} ({positive ? "+" : "−"}
              {Math.abs(changePct).toFixed(2)}%)
            </span>
          </div>
        </div>
        <div className="text-[10px] uppercase tracking-widest text-white/40">
          paper · simulated
        </div>
      </div>

      {data.length < 2 ? (
        <div
          className="flex items-center justify-center rounded-2xl border border-dashed border-white/10 text-[12px] text-white/50"
          style={{ height }}
        >
          No closed trades yet — curve builds as fills confirm.
        </div>
      ) : (
        <div style={{ width: "100%", height }}>
          <ResponsiveContainer>
            <AreaChart data={data} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={PURPLE} stopOpacity={0.4} />
                  <stop offset="100%" stopColor={PURPLE} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(v) =>
                  new Date(v as number).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })
                }
                stroke="rgba(255,255,255,0.3)"
                fontSize={10}
                minTickGap={40}
              />
              <YAxis
                domain={["auto", "auto"]}
                stroke="rgba(255,255,255,0.3)"
                fontSize={10}
                tickFormatter={(v) => `$${Math.round(Number(v)).toLocaleString()}`}
                width={60}
              />
              <Tooltip
                contentStyle={{
                  background: "#0a0a0a",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 12,
                  fontSize: 12,
                }}
                labelFormatter={(v) => new Date(v as number).toLocaleString()}
                formatter={(v) => [fmtUsd(Number(v)), "Equity"]}
              />
              <Area
                type="monotone"
                dataKey="equity"
                stroke={PURPLE}
                strokeWidth={2}
                fill="url(#equityFill)"
                isAnimationActive
                animationDuration={400}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
