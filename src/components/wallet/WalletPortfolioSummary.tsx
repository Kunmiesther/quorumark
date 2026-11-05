import { Eye, EyeOff, RefreshCw, ShieldCheck, Wallet, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useState } from "react";

function fmtUsd(n: number, hidden: boolean) {
  return hidden
    ? "••••"
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function timeAgo(ts: number | null): string {
  if (!ts) return "—";
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export interface WalletPortfolioSummaryProps {
  totalUsd: number;
  walletCount: number;
  healthyCount: number;
  needAttentionCount: number;
  priceTimestamp: number | null;
  isFetching: boolean;
  onRefresh: () => void;
}

/** Portfolio summary above the wallet list. Estimated totals only. */
export function WalletPortfolioSummary(props: WalletPortfolioSummaryProps) {
  const {
    totalUsd,
    walletCount,
    healthyCount,
    needAttentionCount,
    priceTimestamp,
    isFetching,
    onRefresh,
  } = props;
  const [hidden, setHidden] = useState(false);

  return (
    <section className="overflow-hidden rounded-[24px] border border-white/10 bg-gradient-to-br from-primary/15 via-white/[0.04] to-transparent p-5">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Wallet portfolio · estimated
            </span>
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="num font-display text-[32px] font-semibold leading-none tracking-tight text-foreground">
              {fmtUsd(totalUsd, hidden)}
            </span>
            <span className="text-[11px] font-medium text-muted-foreground">USD</span>
          </div>
          <p className="mt-1 text-[10.5px] text-muted-foreground">
            {isFetching ? "Refreshing prices…" : `Prices updated ${timeAgo(priceTimestamp)}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setHidden((v) => !v)}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.06] text-muted-foreground transition hover:text-foreground"
            aria-label={hidden ? "Show balances" : "Hide balances"}
          >
            {hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.06] text-muted-foreground transition hover:text-foreground"
            aria-label="Refresh"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2">
        <Stat icon={<Wallet className="h-3.5 w-3.5" />} label="Wallets" value={String(walletCount)} tone="neutral" />
        <Stat icon={<CheckCircle2 className="h-3.5 w-3.5" />} label="Healthy" value={String(healthyCount)} tone="positive" />
        <Stat
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          label="Attention"
          value={String(needAttentionCount)}
          tone={needAttentionCount > 0 ? "negative" : "muted"}
        />
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[10.5px] text-muted-foreground">
        <ShieldCheck className="mt-[1px] h-3 w-3 shrink-0 text-primary/80" />
        Values are estimates from public price feeds. Trading balances on
        connected exchanges are shown separately on their own venue cards.
      </div>
    </section>
  );
}

function Stat({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: "positive" | "negative" | "muted" | "neutral";
}) {
  const toneCls =
    tone === "positive"
      ? "text-positive"
      : tone === "negative"
        ? "text-negative"
        : tone === "muted"
          ? "text-muted-foreground"
          : "text-foreground";
  return (
    <div className="rounded-xl bg-white/[0.04] px-3 py-2">
      <div className={`flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider ${toneCls}`}>
        {icon}
        {label}
      </div>
      <p className={`num mt-0.5 text-[16px] font-semibold ${toneCls}`}>{value}</p>
    </div>
  );
}
