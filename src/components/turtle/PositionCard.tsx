import { useEffect, useState } from "react";
import {
  ArrowUpRight, ArrowDownRight, ChevronDown, X, Shield, Target, Layers,
} from "lucide-react";
import { toast } from "sonner";

export type Position = {
  id: string;
  pair: string;
  side: "long" | "short";
  exchange: string;
  entry: number;
  pnl: number;
  pnlPct: number;
  openedAt?: number;          // epoch ms, for time-in-trade
  leverage?: number;          // futures only
  stopLoss?: number | null;
  takeProfit?: number | null;
};

function durationLabel(openedAt: number, now: number): string {
  const s = Math.max(1, Math.round((now - openedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return `${h}h ${mm}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function PositionCard({ position }: { position: Position }) {
  const [open, setOpen] = useState(false);
  const [sl, setSl] = useState<string>(position.stopLoss != null ? String(position.stopLoss) : "");
  const [tp, setTp] = useState<string>(position.takeProfit != null ? String(position.takeProfit) : "");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!position.openedAt) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [position.openedAt]);

  const isLong = position.side === "long";
  const pnlPositive = position.pnl >= 0;

  return (
    <li className="bento overflow-hidden">
      {/* Header row */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-3 text-left transition hover:bg-white/[0.02]"
      >
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
            isLong ? "bg-positive/15 text-positive" : "bg-negative/15 text-negative"
          }`}
        >
          {isLong ? (
            <ArrowUpRight className="h-4 w-4" strokeWidth={2.4} />
          ) : (
            <ArrowDownRight className="h-4 w-4" strokeWidth={2.4} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold">{position.pair}</span>
            <span className={`rounded-md px-1.5 py-0.5 text-[9.5px] font-bold tracking-wider ${
              isLong ? "bg-positive/15 text-positive" : "bg-negative/15 text-negative"
            }`}>
              {position.side.toUpperCase()}
            </span>
            {position.leverage != null && (
              <span className="flex items-center gap-0.5 rounded-md bg-gold/15 px-1.5 py-0.5 text-[9.5px] font-bold tracking-wider text-gold">
                <Layers className="h-2.5 w-2.5" />
                {position.leverage}x
              </span>
            )}
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>{position.exchange}</span>
            <span>·</span>
            <span>entry <span className="num">${position.entry.toLocaleString()}</span></span>
            {position.openedAt && (
              <>
                <span>·</span>
                <span className="num">{durationLabel(position.openedAt, now)}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-right">
            <p className={`num text-sm font-semibold ${pnlPositive ? "text-positive" : "text-negative"}`}>
              {pnlPositive ? "+" : "−"}${Math.abs(position.pnl).toFixed(2)}
            </p>
            <p className={`num text-[11px] ${pnlPositive ? "text-positive" : "text-negative"}`}>
              {pnlPositive ? "+" : ""}{position.pnlPct.toFixed(2)}%
            </p>
          </div>
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </div>
      </button>

      {/* Expanded controls */}
      {open && (
        <div className="border-t border-white/[0.06] bg-black/15 px-3 py-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <Shield className="h-3 w-3" /> Stop loss
              </span>
              <input
                inputMode="decimal"
                value={sl}
                onChange={(e) => setSl(e.target.value)}
                placeholder="—"
                className="num h-9 rounded-lg border border-white/10 bg-black/30 px-2.5 text-[13px] outline-none transition focus:border-negative/60"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <Target className="h-3 w-3" /> Take profit
              </span>
              <input
                inputMode="decimal"
                value={tp}
                onChange={(e) => setTp(e.target.value)}
                placeholder="—"
                className="num h-9 rounded-lg border border-white/10 bg-black/30 px-2.5 text-[13px] outline-none transition focus:border-positive/60"
              />
            </label>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => toast.success(`Saved SL/TP for ${position.pair}`)}
              className="flex h-9 flex-1 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-[12px] font-semibold transition hover:bg-white/[0.08]"
            >
              Update orders
            </button>
            <button
              onClick={() => toast.success(`Closing ${position.pair} at market`)}
              className="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-negative/90 px-3 text-[12px] font-semibold text-white transition hover:bg-negative"
            >
              <X className="h-3.5 w-3.5" />
              Close position
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
