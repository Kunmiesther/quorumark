import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, type ReactNode } from "react";
import { Activity, AlertCircle, Clock3, Coins, Cpu, Gauge, RefreshCw } from "lucide-react";
import {
  getAdminAiUsage,
  type AiUsageRange,
  type AdminAiUsageReport,
} from "@/lib/admin/ai-usage.functions";
import { SurfaceCard } from "@/components/phantom/SurfaceCard";

export const Route = createFileRoute("/_authenticated/admin/ai-usage")({
  component: AdminAiUsageRoute,
  head: () => ({
    meta: [
      { title: "AI Usage & Cost — TurtleBot Admin" },
      { name: "description", content: "Owner-only AI usage, estimated cost, reliability, and latency." },
    ],
  }),
});

const RANGE_LABELS: Record<AiUsageRange, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };

function AdminAiUsageRoute() {
  const [range, setRange] = useState<AiUsageRange>("7d");
  const fetchUsage = useServerFn(getAdminAiUsage);
  const query = useQuery({
    queryKey: ["admin", "ai-usage", range],
    queryFn: () => fetchUsage({ data: { range } }),
    refetchInterval: 60_000,
  });

  if (query.error) {
    const message = query.error instanceof Error ? query.error.message : String(query.error);
    return (
      <div className="mx-auto max-w-lg px-5 pt-24">
        <SurfaceCard className="border-red-500/30 p-5">
          <div className="flex items-center gap-2 text-red-300">
            <AlertCircle className="h-5 w-5" />
            <h1 className="font-semibold">AI usage is unavailable</h1>
          </div>
          <p className="mt-2 text-sm text-white/55">{message}</p>
        </SurfaceCard>
      </div>
    );
  }

  const report = query.data;
  return (
    <div className="tb-mobile-dashboard mx-auto min-h-dvh max-w-6xl px-4 pb-10 pt-20 sm:px-6 lg:pt-24">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.24em] text-[var(--accent)]">
            <Gauge className="h-4 w-4" /> Operations · AI
          </div>
          <h1 className="mt-2 font-display text-3xl font-semibold text-white sm:text-4xl">Usage & cost</h1>
          <p className="mt-1 max-w-xl text-sm text-white/50">
            Provider-reported tokens, reliability, and estimated TurtleBot spend. No prompts or answers are stored here.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          className="tb-neu-raised flex min-h-11 items-center gap-2 rounded-2xl px-4 text-sm text-white/75 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} /> Refresh
        </button>
      </header>

      <div className="tb-neu-inset mb-5 grid grid-cols-3 gap-1 rounded-2xl p-1.5" aria-label="Usage range">
        {(Object.keys(RANGE_LABELS) as AiUsageRange[]).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setRange(item)}
            className={`min-h-11 rounded-xl text-xs font-semibold transition ${
              item === range ? "tb-neu-raised text-white" : "text-white/45"
            }`}
          >
            {RANGE_LABELS[item]}
          </button>
        ))}
      </div>

      {query.isLoading || !report ? (
        <SurfaceCard className="flex min-h-52 items-center justify-center text-sm text-white/45">
          Loading metering data…
        </SurfaceCard>
      ) : (
        <Dashboard report={report} />
      )}
    </div>
  );
}

function Dashboard({ report }: { report: AdminAiUsageReport }) {
  const totalTokens = report.totals.inputTokens + report.totals.outputTokens;
  return (
    <>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Metric icon={<Coins />} label="Estimated spend" value={formatUsd(report.totals.costUsd)} accent />
        <Metric icon={<Activity />} label="API attempts" value={formatCount(report.totals.requests)} />
        <Metric icon={<Cpu />} label="Total tokens" value={formatCount(totalTokens)} />
        <Metric icon={<Gauge />} label="Success rate" value={`${report.totals.successRate.toFixed(1)}%`} />
        <Metric icon={<Clock3 />} label="Avg latency" value={formatLatency(report.totals.averageLatencyMs)} />
      </section>

      <section className="mt-5 grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
        <SurfaceCard className="p-4 sm:p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-lg text-white">Spend trend</h2>
              <p className="text-xs text-white/45">Daily estimated model cost</p>
            </div>
            <span className="num text-xs text-white/50">{RANGE_LABELS[report.range]}</span>
          </div>
          <CostBars report={report} />
        </SurfaceCard>

        <SurfaceCard className="p-4 sm:p-5">
          <h2 className="font-display text-lg text-white">Token mix</h2>
          <div className="mt-4 space-y-3">
            <TokenRow label="Input" value={report.totals.inputTokens} total={totalTokens} />
            <TokenRow label="Output" value={report.totals.outputTokens} total={totalTokens} />
            <TokenRow label="Cached input" value={report.totals.cachedInputTokens} total={report.totals.inputTokens} />
          </div>
          <p className="mt-5 text-[11px] leading-relaxed text-white/40">
            {report.totals.unpricedRequests > 0
              ? `${report.totals.unpricedRequests} request(s) used models without a registered price and are shown at $0 until priced.`
              : "Every metered model in this range has a registered estimate."}
          </p>
        </SurfaceCard>
      </section>

      <SurfaceCard className="mt-5 p-4 sm:p-5">
        <h2 className="font-display text-lg text-white">Cost by feature</h2>
        <p className="text-xs text-white/45">Where model usage originates inside TurtleBot</p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {report.features.map((item) => (
            <div key={item.feature} className="tb-neu-inset rounded-2xl px-3.5 py-3">
              <div className="flex items-center justify-between gap-3">
                <p className="truncate text-sm font-semibold text-white/80">{humanize(item.feature)}</p>
                <p className="num text-xs text-[var(--accent)]">{formatUsd(item.costUsd)}</p>
              </div>
              <p className="mt-1 text-[10px] text-white/35">{formatCount(item.requests)} attempts · {formatCount(item.tokens)} tokens</p>
            </div>
          ))}
          {report.features.length === 0 && <Empty text="No feature usage recorded yet." />}
        </div>
      </SurfaceCard>

      <SurfaceCard className="mt-5 overflow-hidden p-0">
        <div className="border-b border-white/[0.06] px-4 py-4 sm:px-5">
          <h2 className="font-display text-lg text-white">Provider breakdown</h2>
          <p className="text-xs text-white/45">Models ordered by estimated spend</p>
        </div>
        <div className="divide-y divide-white/[0.05]">
          {report.breakdown.map((item) => (
            <div key={item.key} className="grid grid-cols-[1fr_auto] gap-3 px-4 py-3.5 sm:grid-cols-[1fr_repeat(3,110px)] sm:px-5">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">{item.model}</p>
                <p className="text-[11px] uppercase tracking-wider text-white/40">{item.provider}</p>
              </div>
              <Stat label="Cost" value={formatUsd(item.costUsd)} />
              <Stat className="hidden sm:block" label="Requests" value={formatCount(item.requests)} />
              <Stat className="hidden sm:block" label="Tokens" value={formatCount(item.tokens)} />
            </div>
          ))}
          {report.breakdown.length === 0 && <Empty text="No AI calls have been recorded in this range." />}
        </div>
      </SurfaceCard>

      <SurfaceCard className="mt-5 overflow-hidden p-0">
        <div className="border-b border-white/[0.06] px-4 py-4 sm:px-5">
          <h2 className="font-display text-lg text-white">Recent activity</h2>
          <p className="text-xs text-white/45">Latest server-side AI attempts</p>
        </div>
        <div className="divide-y divide-white/[0.05]">
          {report.recent.slice(0, 12).map((row) => (
            <div key={row.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${row.status === "success" ? "bg-emerald-400" : "bg-red-400"}`} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-white/85">{row.model}</p>
                <p className="truncate text-[11px] text-white/40">{humanize(row.feature)} · {new Date(row.created_at).toLocaleString()}</p>
              </div>
              <div className="text-right">
                <p className="num text-xs text-white/75">{formatUsd(Number(row.estimated_cost_usd))}</p>
                <p className="num text-[10px] text-white/35">{formatCount(Number(row.input_tokens) + Number(row.output_tokens))} tok</p>
              </div>
            </div>
          ))}
          {report.recent.length === 0 && <Empty text="New AI calls will appear here automatically." />}
        </div>
      </SurfaceCard>

      <p className="mt-4 text-center text-[10px] leading-relaxed text-white/35">
        Updated {new Date(report.generatedAt).toLocaleString()} · Estimates use the versioned TurtleBot price registry; provider invoices are authoritative.
      </p>
    </>
  );
}

function Metric({ icon, label, value, accent = false }: { icon: ReactNode; label: string; value: string; accent?: boolean }) {
  return (
    <SurfaceCard className="p-3.5 sm:p-4">
      <div className={`flex h-9 w-9 items-center justify-center rounded-xl [&>svg]:h-4 [&>svg]:w-4 ${accent ? "bg-[color:var(--accent)]/15 text-[var(--accent)]" : "tb-neu-inset text-white/55"}`}>{icon}</div>
      <p className="mt-3 text-[10px] uppercase tracking-wider text-white/40">{label}</p>
      <p className={`num mt-1 text-xl font-semibold ${accent ? "text-[var(--accent)]" : "text-white"}`}>{value}</p>
    </SurfaceCard>
  );
}

function CostBars({ report }: { report: AdminAiUsageReport }) {
  const max = Math.max(...report.daily.map((day) => day.costUsd), 0.000001);
  if (report.daily.length === 0) return <Empty text="No daily spend yet." />;
  return (
    <div className="flex h-44 items-end gap-1.5" aria-label="Daily estimated cost chart">
      {report.daily.map((day) => (
        <div key={day.date} className="group flex h-full min-w-0 flex-1 flex-col justify-end" title={`${day.date}: ${formatUsd(day.costUsd)} · ${day.requests} requests`}>
          <div className="tb-neu-inset relative h-full overflow-hidden rounded-lg">
            <div className="absolute inset-x-0 bottom-0 rounded-lg bg-gradient-to-t from-violet-700 to-[var(--accent)]" style={{ height: `${Math.max(3, (day.costUsd / max) * 100)}%` }} />
          </div>
          <span className="mt-1 truncate text-center text-[8px] text-white/30">{day.date.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

function TokenRow({ label, value, total }: { label: string; value: number; total: number }) {
  const percent = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-xs"><span className="text-white/55">{label}</span><span className="num text-white/80">{formatCount(value)}</span></div>
      <div className="tb-neu-inset h-2 overflow-hidden rounded-full"><div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${percent}%` }} /></div>
    </div>
  );
}

function Stat({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return <div className={`text-right ${className}`}><p className="text-[9px] uppercase tracking-wider text-white/35">{label}</p><p className="num mt-0.5 text-xs text-white/75">{value}</p></div>;
}

function Empty({ text }: { text: string }) {
  return <div className="flex min-h-24 items-center justify-center px-5 text-center text-xs text-white/40">{text}</div>;
}

function formatCount(value: number) {
  return Intl.NumberFormat(undefined, { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function formatUsd(value: number) {
  const digits = value > 0 && value < 0.01 ? 4 : 2;
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatLatency(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function humanize(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
