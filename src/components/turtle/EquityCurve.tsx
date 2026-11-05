import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

type Range = "24h" | "7d" | "30d" | "all";

const RANGE_MS: Record<Range, number | null> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  all: null,
};

export function EquityCurve({ baseline = 0 }: { baseline?: number }) {
  const { user } = useAuth();
  const [range, setRange] = useState<Range>("7d");

  const { data: trades } = useQuery({
    queryKey: ["equity-trades", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("trades")
        .select("closed_at, realized_pnl")
        .eq("user_id", user!.id)
        .order("closed_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  const { points, change, changePct, isEmpty } = useMemo(() => {
    const cutoff = RANGE_MS[range];
    const now = Date.now();
    const rows = (trades ?? []).filter((t) => {
      if (cutoff == null) return true;
      return now - new Date(t.closed_at).getTime() <= cutoff;
    });

    if (rows.length === 0) {
      return { points: [] as { t: number; v: number }[], change: 0, changePct: 0, isEmpty: true };
    }

    let cum = baseline;
    const series: { t: number; v: number }[] = [
      { t: new Date(rows[0].closed_at).getTime() - 1, v: cum },
    ];
    for (const r of rows) {
      cum += Number(r.realized_pnl ?? 0);
      series.push({ t: new Date(r.closed_at).getTime(), v: cum });
    }
    const start = series[0].v;
    const end = series[series.length - 1].v;
    const ch = end - start;
    const pct = start !== 0 ? (ch / Math.abs(start)) * 100 : 0;
    return { points: series, change: ch, changePct: pct, isEmpty: false };
  }, [trades, range, baseline]);

  const W = 320;
  const H = 96;
  const PAD = 4;

  const path = useMemo(() => {
    if (points.length < 2) return { line: "", area: "" };
    const ts = points.map((p) => p.t);
    const vs = points.map((p) => p.v);
    const tMin = Math.min(...ts);
    const tMax = Math.max(...ts);
    const vMin = Math.min(...vs);
    const vMax = Math.max(...vs);
    const tSpan = tMax - tMin || 1;
    const vSpan = vMax - vMin || 1;
    const xy = points.map((p) => {
      const x = PAD + ((p.t - tMin) / tSpan) * (W - PAD * 2);
      const y = PAD + (1 - (p.v - vMin) / vSpan) * (H - PAD * 2);
      return [x, y] as const;
    });
    const line = xy
      .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
      .join(" ");
    const area = `${line} L${xy[xy.length - 1][0].toFixed(1)},${H} L${xy[0][0].toFixed(1)},${H} Z`;
    return { line, area };
  }, [points]);

  const positive = change >= 0;
  const stroke = positive ? "rgb(115 255 184)" : "rgb(248 113 113)";

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <span className="text-label-sm">Equity · {range}</span>
          {!isEmpty && (
            <p
              className={`num mt-0.5 text-[13px] font-semibold ${
                positive ? "text-positive" : "text-negative"
              }`}
            >
              {positive ? "+" : "−"}${Math.abs(change).toFixed(2)}
              <span className="ml-1 opacity-80">
                ({positive ? "+" : ""}
                {changePct.toFixed(2)}%)
              </span>
            </p>
          )}
        </div>
        <div className="flex gap-1">
          {(["24h", "7d", "30d", "all"] as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold transition ${
                range === r
                  ? "bg-primary/20 text-primary"
                  : "bg-white/[0.04] text-muted-foreground hover:bg-white/[0.08]"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2">
        {isEmpty ? (
          <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-white/10 text-[11px] text-muted-foreground">
            No closed trades in this range
          </div>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full" preserveAspectRatio="none">
            <defs>
              <linearGradient id="equityG" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
                <stop offset="100%" stopColor={stroke} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={path.area} fill="url(#equityG)" />
            <path
              d={path.line}
              fill="none"
              stroke={stroke}
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>
    </div>
  );
}
