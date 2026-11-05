/**
 * LifeMapCharts — donut of obligation mix by category + horizontal bars of
 * coverage. Visual language matches /paper: SurfaceCard shell, purple
 * accent (#9945FF), green accent (#14F195), font-mono numbers.
 */
import { useMemo } from "react";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { CATEGORIES } from "@/lib/lifemap/catalog";

export interface LifeMapChartsBill {
  id: string;
  amount_usd: number;
  category: string | null;
}
export interface LifeMapChartsAlloc {
  bill_id: string;
  covered_usd: number;
}

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

export function LifeMapCharts({
  bills,
  allocations,
}: {
  bills: LifeMapChartsBill[];
  allocations: LifeMapChartsAlloc[];
}) {
  const rows = useMemo(() => {
    const covByBill = new Map(allocations.map((a) => [a.bill_id, a.covered_usd]));
    const map = new Map<string, { target: number; covered: number }>();
    for (const c of CATEGORIES) map.set(c.key, { target: 0, covered: 0 });
    map.set("__other", { target: 0, covered: 0 });
    for (const b of bills) {
      const key = b.category && map.has(b.category) ? b.category : "__other";
      const bucket = map.get(key)!;
      bucket.target += b.amount_usd;
      bucket.covered += Math.min(b.amount_usd, covByBill.get(b.id) ?? 0);
    }
    return CATEGORIES.filter((c) => (map.get(c.key)?.target ?? 0) > 0)
      .map((c) => {
        const m = map.get(c.key)!;
        return {
          key: c.key,
          label: c.label,
          accent: c.accent,
          target: m.target,
          covered: m.covered,
          gap: Math.max(0, m.target - m.covered),
          pct: m.target > 0 ? Math.min(100, Math.round((m.covered / m.target) * 100)) : 0,
        };
      })
      .sort((a, b) => b.target - a.target);
  }, [bills, allocations]);

  const total = rows.reduce((a, r) => a + r.target, 0);
  const covered = rows.reduce((a, r) => a + r.covered, 0);

  if (rows.length === 0) {
    return (
      <div className="rounded-3xl bg-white/[0.04] p-8 text-center text-[12px] text-white/50">
        Add a bill under any category to see your charts light up.
      </div>
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="rounded-3xl bg-white/[0.04] p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-widest text-white/60">
            Obligation mix
          </h3>
          <span className="font-mono text-[11px] tabular-nums text-white/40">
            {fmtUsd(total)} target
          </span>
        </div>
        <div className="relative h-64">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={rows}
                dataKey="target"
                nameKey="label"
                cx="50%"
                cy="50%"
                innerRadius={62}
                outerRadius={95}
                paddingAngle={2}
                stroke="none"
              >
                {rows.map((r) => (
                  <Cell key={r.key} fill={r.accent} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  background: "#0b0b12",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 8,
                  color: "#fff",
                  fontSize: 12,
                }}
                formatter={(v: number, n: string) => [fmtUsd(v), n]}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <p className="text-[10px] uppercase tracking-widest text-white/40">Covered</p>
            <p className="font-mono text-[22px] font-bold tabular-nums text-white">
              {fmtUsd(covered)}
            </p>
            <p className="font-mono text-[10px] tabular-nums text-[#14F195]">
              of {fmtUsd(total)}
            </p>
          </div>
        </div>
        <ul className="mt-3 grid grid-cols-2 gap-1.5 text-[11px]">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: r.accent }}
              />
              <span className="truncate text-white/70">{r.label}</span>
              <span className="ml-auto font-mono tabular-nums text-white/40">{r.pct}%</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-3xl bg-white/[0.04] p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-widest text-white/60">
            Coverage by bucket
          </h3>
          <span className="font-mono text-[11px] tabular-nums text-white/40">
            {rows.length} categor{rows.length === 1 ? "y" : "ies"}
          </span>
        </div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={rows}
              layout="vertical"
              margin={{ top: 4, right: 12, bottom: 0, left: -8 }}
            >
              <CartesianGrid stroke="rgba(255,255,255,0.05)" horizontal={false} />
              <XAxis
                type="number"
                tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `$${v}`}
              />
              <YAxis
                type="category"
                dataKey="label"
                tick={{ fill: "rgba(255,255,255,0.6)", fontSize: 11 }}
                width={78}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                contentStyle={{
                  background: "#0b0b12",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 8,
                  color: "#fff",
                  fontSize: 12,
                }}
                formatter={(v: number, n: string) => [
                  fmtUsd(v),
                  n === "covered" ? "Covered" : "Target",
                ]}
              />
              <Bar dataKey="target" fill="#2a1a4a" radius={[0, 6, 6, 0]} />
              <Bar dataKey="covered" fill="#9945FF" radius={[0, 6, 6, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
