/**
 * StrategyLiveCard — Life Map strategy tile with a persisted bot on/off
 * control. Trading stats and heartbeat are read-only; execution logic is
 * server-side and NOT changed by this component.
 *
 * Honesty rules (do not weaken):
 *   • The environment badge (PAPER / TESTING / LIVE) reflects the persisted
 *     wiring only. A card is only labelled LIVE when both `live` and
 *     `engineStrategy` are truthy AND the persisted toggle is on.
 *   • Trading stats render real numbers only when `engineStrategy` is
 *     non-null and the strategy is wired live; otherwise every stat shows
 *     an em-dash. Win% shows "—" when there are zero trades.
 *   • The bot on/off switch persists via `public.user_strategy_toggles`
 *     (RLS-scoped). No optimistic success — the switch flips only after
 *     the server confirms. Errors surface inline and revert.
 *   • Off blocks NEW entries. Existing position safety management (stops,
 *     TPs, kill switch) continues server-side; the confirm dialog states
 *     this explicitly when open positions exist.
 *
 * Ledger blockers (Phase 5A — not this turn):
 *   • Realized earnings, bill progress, points awarded/pending, and
 *     withdrawal/verification state are NOT wired here. They require the
 *     `bill_earnings_allocations`, `life_points_awards`, and
 *     `bill_withdrawal_links` ledgers from Slice 5A-2. Rendering fabricated
 *     numbers would violate the product contract, so those affordances are
 *     intentionally omitted until the ledger tables exist.
 */
import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { AlertCircle, FlaskConical, Lock, Radio } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { TurtleDef, TurtleRisk } from "@/lib/turtles";
import { lifeMapTurtleImage } from "@/lib/lifemap-turtle-images";
import {
  useStrategyTradingStats,
  type StrategyTradingStats,
} from "@/hooks/useStrategyTradingStats";
import { useStrategyEnabled } from "@/hooks/useStrategyEnabled";
import { useBotHealth } from "@/hooks/useBotHealth";

export type StrategyCardStatus = "active" | "testing" | "soon";

const RISK_LABEL: Record<TurtleRisk, string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};

/**
 * @param turtle           display metadata (name, accent, art, risk)
 * @param purpose          one-liner shown under the name
 * @param status           lifecycle label (ACTIVE / TESTING / COMING SOON)
 * @param live             true only when the strategy IS wired into the
 *                         paper engine right now. Together with the
 *                         persisted toggle, gates the LIVE environment tag.
 * @param engineStrategy   the `paper_positions.strategy` value to aggregate
 *                         over. Null if the strategy has no trading logic.
 * @param dashboardTo      route target for the "View progress" affordance.
 * @param onOpen           opens the strategy drawer (manage strategies /
 *                         bill attachments UI owned by the parent).
 */
export function StrategyLiveCard({
  turtle,
  purpose,
  status,
  live,
  engineStrategy,
  dashboardTo = "/trade",
  onOpen,
}: {
  turtle: TurtleDef;
  purpose: string;
  status: StrategyCardStatus;
  live: boolean;
  engineStrategy: string | null;
  dashboardTo?: "/trade";

  onOpen?: () => void;
}) {
  const toggle = useStrategyEnabled(engineStrategy);
  const health = useBotHealth();

  const enabled = toggle.enabled === true;
  const stats = useStrategyTradingStats(
    live && engineStrategy ? engineStrategy : null,
  );

  const showRealStats = live && !!engineStrategy;
  const view = useMemo(
    () => formatStats(stats.data, showRealStats, stats.isLoading),
    [stats.data, showRealStats, stats.isLoading],
  );

  // Environment truth: only "LIVE" when the persisted wiring says so.
  const env: EnvTag = useMemo(() => {
    if (status === "soon") return "SOON";
    if (!live || !engineStrategy) return "TESTING";
    // Prefer heartbeat mode; fall back to paper (this engine is paper).
    const mode = (health.worker.mode ?? "").toLowerCase();
    if (mode === "live") return "LIVE";
    if (mode === "testnet") return "TESTNET";
    return "PAPER";
  }, [status, live, engineStrategy, health.worker.mode]);

  const accent = turtle.accent;
  const focusable = !!engineStrategy;

  const borderColor = enabled
    ? `color-mix(in oklab, ${accent} 55%, transparent)`
    : "rgba(255,255,255,0.08)";
  const glowShadow = enabled
    ? `0 0 0 1px color-mix(in oklab, ${accent} 40%, transparent), 0 8px 30px -12px color-mix(in oklab, ${accent} 55%, transparent)`
    : undefined;

  const openPositions = view.openCount;
  const lastTickIso = health.worker.lastSeenAt ?? null;

  return (
    <article
      className={cn(
        "group relative flex h-full w-full flex-col overflow-hidden rounded-2xl border bg-white/[0.04] text-left transition",
        !enabled && "opacity-90",
      )}
      style={{ borderColor, boxShadow: glowShadow }}
    >
      {/* image + single environment badge (top-right) */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${turtle.name} — ${env.toLowerCase()}. Open details.`}
        className="relative block aspect-[4/3] w-full overflow-hidden text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-white/25"
        style={{
          background: `radial-gradient(120% 80% at 50% 100%, color-mix(in oklab, ${accent} 22%, transparent), transparent 70%)`,
        }}
      >
        <img
          src={lifeMapTurtleImage(turtle.slug)}
          alt=""
          loading="lazy"
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]",
            !enabled && "grayscale-[35%]",
          )}
          style={{ objectPosition: "center 22%" }}
        />
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(10,10,14,0.05) 0%, rgba(10,10,14,0.35) 60%, rgba(10,10,14,0.85) 100%)",
          }}
        />
        {/* SINGLE env badge — top-right. Optional running dot on the left. */}
        <div className="absolute right-1.5 top-1.5">
          <EnvBadge env={env} accent={accent} />
        </div>
        {enabled && env !== "SOON" && (
          <div className="absolute left-1.5 top-1.5">
            <StatusDot accent={accent} />
          </div>
        )}
      </button>

      {/* body */}
      <div className="flex flex-1 flex-col p-2.5">
        <p className="text-[13px] font-semibold uppercase leading-tight tracking-[0.04em] text-white">
          {turtle.name}
        </p>
        <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-white/60">
          {purpose}
        </p>
        <div className="mt-2 flex items-center gap-1.5">
          <span
            className="rounded-full border px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.14em]"
            style={{
              color: accent,
              background: `color-mix(in oklab, ${accent} 12%, transparent)`,
              borderColor: `color-mix(in oklab, ${accent} 40%, transparent)`,
            }}
          >
            {RISK_LABEL[turtle.risk]}
          </span>
        </div>

        {/* trading stats grid */}
        <div className="mt-2 rounded-md bg-white/[0.03] p-2 ring-1 ring-white/[0.04]">
          <div className="grid grid-cols-2 gap-1.5">
            <MiniStat label="Trades" value={view.trades} accent={accent} />
            <MiniStat label="Win%" value={view.winRate} accent={accent} />
            <MiniStat
              label="Net P&L"
              value={view.pnl}
              accent={accent}
              tone={view.pnlTone}
            />
            <MiniStat label="Open" value={view.open} accent={accent} />
          </div>
        </div>

        {/* Dedicated Bot on/off control row */}
        <div
          className="mt-2.5 flex min-h-11 items-center justify-between gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/70">
              Bot {toggle.enabled === null ? "n/a" : enabled ? "on" : "off"}
            </span>
            <span className="mt-0.5 font-mono text-[9.5px] text-white/40">
              {lastTickIso ? `Tick ${formatAgo(lastTickIso)}` : "No tick yet"}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {toggle.error && (
              <AlertCircle
                className="h-3.5 w-3.5 text-[hsl(var(--state-danger))]"
                aria-label={`Toggle error: ${toggle.error.message}`}
              />
            )}
            <Switch
              checked={enabled}
              disabled={
                toggle.enabled === null || toggle.isLoading || toggle.isSaving
              }
              onCheckedChange={(next) => {
                if (!next && openPositions > 0) {
                  const ok =
                    typeof window !== "undefined"
                      ? window.confirm(
                          `Turn ${turtle.name} off?\n\n` +
                            `${openPositions} open position${openPositions === 1 ? "" : "s"}.\n` +
                            `New entries will stop immediately.\n` +
                            `Risk-management exits (stops, TPs, kill switch) continue to run on open positions.`,
                        )
                      : true;
                  if (!ok) return;
                }
                void toggle.setEnabled(next);
              }}
              aria-label={`Turn ${turtle.name} bot ${enabled ? "off" : "on"}`}
              className="scale-90"
              style={{ ["--switch-checked-bg" as string]: accent }}
            />
          </div>
        </div>

        {/* Actions row: primary grows, secondary never clips. */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {focusable ? (
            <Link
              to={dashboardTo}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex min-h-10 flex-1 min-w-[140px] items-center justify-center rounded-md border border-white/10 bg-white/[0.02] px-2 font-mono text-[10px] uppercase tracking-[0.14em] transition hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/25"
              style={{ color: accent }}
            >
              View progress →
            </Link>
          ) : (
            <span className="inline-flex min-h-10 flex-1 min-w-[140px] items-center justify-center rounded-md border border-dashed border-white/10 bg-white/[0.02] px-2 font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
              <Lock className="mr-1 h-3 w-3" /> Coming soon
            </span>
          )}
          {onOpen && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }}
              className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-white/70 transition hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/25"
            >
              Manage
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

/* ================================================================= */

type EnvTag = "LIVE" | "TESTNET" | "PAPER" | "TESTING" | "SOON";

interface FormattedStats {
  trades: string;
  winRate: string;
  pnl: string;
  open: string;
  pnlTone: "success" | "danger" | "neutral";
  openCount: number;
}

function formatStats(
  data: StrategyTradingStats | undefined,
  showReal: boolean,
  loading: boolean,
): FormattedStats {
  if (!showReal) {
    return {
      trades: "—",
      winRate: "—",
      pnl: "—",
      open: "—",
      pnlTone: "neutral",
      openCount: 0,
    };
  }
  if (loading || !data) {
    return {
      trades: "…",
      winRate: "…",
      pnl: "…",
      open: "…",
      pnlTone: "neutral",
      openCount: 0,
    };
  }
  const tone: "success" | "danger" | "neutral" =
    data.pnl > 0 ? "success" : data.pnl < 0 ? "danger" : "neutral";
  // Never show 100% without a sample count: format as "83% (12)".
  const winRate =
    data.trades > 0
      ? `${Math.round(data.winRate * 100)}% (${data.trades})`
      : "—";
  return {
    trades: String(data.trades),
    winRate,
    pnl: formatUsd(data.pnl),
    open: String(data.open),
    pnlTone: tone,
    openCount: data.open,
  };
}

function formatUsd(n: number): string {
  const rounded = Math.round(n);
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return `${sign}$${Math.abs(rounded).toLocaleString()}`;
}

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms) || ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/* ================================================================= */

function EnvBadge({ env, accent }: { env: EnvTag; accent: string }) {
  const style: React.CSSProperties =
    env === "LIVE"
      ? {
          color: accent,
          background: `color-mix(in oklab, ${accent} 14%, transparent)`,
          borderColor: `color-mix(in oklab, ${accent} 50%, transparent)`,
        }
      : env === "TESTNET"
        ? {
            color: "var(--warn-amber)",
            background: "color-mix(in oklab, var(--warn-amber) 12%, transparent)",
            borderColor: "color-mix(in oklab, var(--warn-amber) 40%, transparent)",
          }
        : env === "PAPER"
          ? {
              color: "var(--verified)",
              background: "color-mix(in oklab, var(--verified) 12%, transparent)",
              borderColor: "color-mix(in oklab, var(--verified) 40%, transparent)",
            }
          : env === "TESTING"
            ? {
                color: "var(--warn-amber)",
                background: "color-mix(in oklab, var(--warn-amber) 10%, transparent)",
                borderColor: "color-mix(in oklab, var(--warn-amber) 35%, transparent)",
              }
            : {
                color: "var(--text-secondary)",
                background: "rgba(255,255,255,0.04)",
                borderColor: "rgba(255,255,255,0.10)",
              };
  const Icon =
    env === "LIVE"
      ? Radio
      : env === "TESTNET" || env === "TESTING"
        ? FlaskConical
        : env === "SOON"
          ? Lock
          : Radio;
  return (
    <span
      data-testid={`env-badge-${env.toLowerCase()}`}
      className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] backdrop-blur-sm"
      style={style}
    >
      <Icon className="h-2.5 w-2.5" />
      {env === "SOON" ? "Coming soon" : env}
    </span>
  );
}

function StatusDot({ accent }: { accent: string }) {
  return (
    <span aria-hidden className="relative flex h-2 w-2">
      <span
        className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:animate-none"
        style={{ background: accent }}
      />
      <span
        className="relative inline-flex h-2 w-2 rounded-full"
        style={{ background: accent }}
      />
    </span>
  );
}

function MiniStat({
  label,
  value,
  accent,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  accent: string;
  tone?: "success" | "danger" | "neutral";
}) {
  const toneClass =
    tone === "success"
      ? "text-[hsl(var(--state-success))]"
      : tone === "danger"
        ? "text-[hsl(var(--state-danger))]"
        : "text-white";
  return (
    <div className="rounded-md bg-white/[0.02] px-1.5 py-1">
      <div
        className="font-mono text-[8.5px] uppercase tracking-[0.14em]"
        style={{
          color: `color-mix(in oklab, ${accent} 60%, rgba(255,255,255,0.55))`,
        }}
      >
        {label}
      </div>
      <div
        className={cn(
          "font-display text-[13px] font-semibold tabular-nums leading-none",
          toneClass,
        )}
      >
        {value}
      </div>
    </div>
  );
}
