import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Radar, ArrowUp, ArrowDown, ExternalLink, AlertTriangle, Radio, Power } from "lucide-react";
import { useScoutActivation } from "@/hooks/useScoutActivation";
import { useScout, type ScoutReport } from "@/hooks/useScout";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import scoutAsset from "@/assets/characters/scout.webp.asset.json";

/**
 * ScoutCard — full strategy-card sized surface for the Scout recon layer.
 *
 * Matches the shape of StrategyCard (image top, name, description, footer)
 * but replaces the "attached bills" region with live Scout stats. The Scout
 * does not take bills — it's report-only recon.
 *
 * Toggle ON → ACTIVE badge + SCANNING pulse. OFF → dimmed inactive state.
 */
export function ScoutCard() {
  const { active, toggle } = useScoutActivation();
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError } = useScout();
  const stats = useMemo(() => computeStats(data ?? []), [data]);

  const ACCENT = "#22D3EE"; // Onixus teal — Scout signature
  const borderColor = active
    ? "color-mix(in oklab, #22D3EE 55%, transparent)"
    : "rgba(255,255,255,0.08)";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Scout — ${active ? "Active recon" : "Off"}. Open live stats.`}
        className={cn(
          "group relative flex h-full w-full flex-col overflow-hidden rounded-2xl border bg-white/[0.04] text-left transition hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
          !active && "opacity-70",
        )}
        style={{ borderColor }}
      >
        {/* image */}
        <div
          className="relative aspect-[4/3] w-full overflow-hidden"
          style={{
            background:
              "radial-gradient(120% 80% at 50% 100%, rgba(34,211,238,0.18), transparent 70%)",
          }}
        >
          <img
            src={scoutAsset.url}
            alt=""
            loading="lazy"
            className={cn(
              "absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]",
              !active && "grayscale",
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

          {/* status badge (top-right) */}
          <div className="absolute right-1.5 top-1.5 flex items-center gap-1">
            {active ? (
              <>
                <span
                  className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] backdrop-blur-sm"
                  style={{
                    color: "var(--verified)",
                    background: "color-mix(in oklab, var(--verified) 14%, transparent)",
                    borderColor: "color-mix(in oklab, var(--verified) 45%, transparent)",
                  }}
                >
                  <Radio className="h-2.5 w-2.5" />
                  Active
                </span>
                <span
                  className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] backdrop-blur-sm"
                  style={{
                    color: "#22D3EE",
                    background: "rgba(34,211,238,0.14)",
                    borderColor: "rgba(34,211,238,0.5)",
                  }}
                >
                  <span aria-hidden className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#22D3EE] opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#22D3EE]" />
                  </span>
                  Scanning
                </span>
              </>
            ) : (
              <span
                className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] backdrop-blur-sm"
                style={{
                  color: "var(--text-secondary)",
                  background: "rgba(255,255,255,0.04)",
                  borderColor: "rgba(255,255,255,0.10)",
                }}
              >
                <Power className="h-2.5 w-2.5" />
                Off
              </span>
            )}
          </div>

          {/* toggle (top-left) — stopPropagation so the card doesn't open */}
          <div
            className="absolute left-1.5 top-1.5"
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <Switch
              checked={active}
              onCheckedChange={toggle}
              aria-label="Activate Scout"
              className="data-[state=checked]:bg-[#22D3EE] scale-75"
            />
          </div>
        </div>

        {/* body */}
        <div className="flex flex-1 flex-col p-2.5">
          <p className="text-[13px] font-semibold uppercase leading-tight tracking-[0.04em] text-white">
            Scout
          </p>
          <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-white/60">
            Market reconnaissance · reports to Onyx · does not trade
          </p>
          <div className="mt-2 flex items-center gap-1.5">
            <span
              className="rounded-full border px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.14em]"
              style={{
                color: ACCENT,
                background: "rgba(34,211,238,0.08)",
                borderColor: "rgba(34,211,238,0.35)",
              }}
            >
              Recon
            </span>
          </div>

          {/* stats — replaces bills row on turtle cards */}
          <div className="mt-2 rounded-md bg-white/[0.03] p-2 ring-1 ring-white/[0.04]">
            {isLoading ? (
              <p className="text-center font-mono text-[10px] uppercase tracking-[0.14em] text-white/45">
                Scanning…
              </p>
            ) : isError ? (
              <p className="flex items-center justify-center gap-1 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-red-300/80">
                <AlertTriangle className="h-2.5 w-2.5" /> Scan failed
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-1.5">
                  <MiniStat label="Blocked" value={stats.blocked} tone="danger" />
                  <MiniStat
                    label="Offense"
                    value={stats.offenseWired ? stats.offense : "—"}
                    tone="success"
                  />
                  <MiniStat label="Up" value={stats.up} tone="success" Icon={ArrowUp} />
                  <MiniStat label="Down" value={stats.down} tone="danger" Icon={ArrowDown} />
                </div>
                {stats.best.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {stats.best.slice(0, 2).map((r) => {
                      const s = r.signal?.scores;
                      const dir = s?.direction ?? "neutral";
                      return (
                        <li key={r.symbol} className="flex items-center gap-1.5 text-[10.5px]">
                          <span className="font-semibold text-white/85">
                            {r.symbol.replace("-USDT", "")}
                          </span>
                          <span
                            className={cn(
                              "font-mono uppercase text-[9.5px] tracking-wider",
                              dir === "long"
                                ? "text-[hsl(var(--state-success))]"
                                : dir === "short"
                                  ? "text-[hsl(var(--state-danger))]"
                                  : "text-white/40",
                            )}
                          >
                            {s?.recommendation ?? "—"}·{dir}
                          </span>
                          <span className="ml-auto font-mono tabular-nums text-white/70">
                            {s?.movement != null ? Math.round(s.movement) : "—"}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </div>

          <div className="mt-auto pt-2.5">
            <span className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-white/55">
              <span>Tap for full stats</span>
              <span className="text-[#22D3EE]">Dashboard →</span>
            </span>
          </div>
        </div>
      </button>

      <ScoutStatsDialog open={open} onOpenChange={setOpen} active={active} />
    </>
  );
}

/* ================================================================= */

function MiniStat({
  label,
  value,
  tone = "neutral",
  Icon,
}: {
  label: string;
  value: number | string;
  tone?: "neutral" | "success" | "danger";
  Icon?: React.ComponentType<{ className?: string }>;
}) {
  const toneClass =
    tone === "success"
      ? "text-[hsl(var(--state-success))]"
      : tone === "danger"
        ? "text-[hsl(var(--state-danger))]"
        : "text-white";
  return (
    <div className="rounded-md bg-white/[0.02] px-1.5 py-1">
      <div className="flex items-center gap-1 text-white/45">
        {Icon && <Icon className="h-2.5 w-2.5" />}
        <span className="font-mono text-[8.5px] uppercase tracking-[0.14em]">{label}</span>
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

/* ================================================================= */

function ScoutStatsDialog({
  open,
  onOpenChange,
  active,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  active: boolean;
}) {
  const { data, isLoading, isError, error } = useScout();
  const stats = useMemo(() => computeStats(data ?? []), [data]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg border-white/10 bg-[#050208] p-0">
        <DialogHeader className="border-b border-white/[0.06] px-5 py-4">
          <div className="flex items-center gap-2">
            <Radar className="h-4 w-4 text-[#22D3EE]" />
            <DialogTitle className="font-display text-[15px] font-semibold text-white">
              Scout · Scan Stats
            </DialogTitle>
            <span
              className={cn(
                "ml-auto rounded px-1.5 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-wider ring-1",
                active
                  ? "bg-[#22D3EE]/15 text-[#22D3EE] ring-[#22D3EE]/40"
                  : "bg-white/5 text-white/50 ring-white/10",
              )}
            >
              {active ? "Scanning" : "Standby"}
            </span>
          </div>
          <DialogDescription className="font-mono text-[11px] text-white/45">
            Real-time recon. Report-only — Onyx decides deployment.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-5 overflow-y-auto px-5 py-4">
          {isLoading ? (
            <p className="py-6 text-center text-[12px] text-white/50">Scanning symbols…</p>
          ) : isError || !data ? (
            <div className="flex items-start gap-2 rounded-lg bg-white/[0.03] p-3 text-[12px] text-red-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error instanceof Error ? error.message : "Scan failed"}</span>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <BigStat
                  label="Counter-trend blocked"
                  value={stats.blocked}
                  hint="Wrong-side setups the trend filter would reject"
                  tone="danger"
                />
                <BigStat
                  label="With-trend candidates"
                  value={stats.offenseWired ? stats.offense : "—"}
                  hint={
                    stats.offenseWired
                      ? "Trend-aligned setups Scout would forward"
                      : "Not wired to live delivery count yet"
                  }
                  tone="success"
                />
                <BigStat label="Trending up" value={stats.up} tone="success" />
                <BigStat label="Trending down" value={stats.down} tone="danger" />
              </div>

              <Section title="Best symbols right now">
                {stats.best.length === 0 ? (
                  <EmptyLine text="No actionable movement — market's quiet." />
                ) : (
                  <ul className="space-y-1.5">
                    {stats.best.map((r) => (
                      <SymbolRow key={r.symbol} r={r} />
                    ))}
                  </ul>
                )}
              </Section>

              {stats.blockedList.length > 0 && (
                <Section title={`Currently blocked (${stats.blockedList.length})`}>
                  <ul className="space-y-1">
                    {stats.blockedList.map((r) => (
                      <li
                        key={r.symbol}
                        className="flex items-center justify-between rounded-md bg-white/[0.02] px-2.5 py-1.5 text-[11px]"
                      >
                        <span className="font-semibold text-white/80">{r.symbol}</span>
                        <span className="font-mono text-white/45">{r.reason}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              <Link
                to="/scout"
                onClick={() => onOpenChange(false)}
                className="flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-[#9945FF] to-[#22D3EE] px-4 py-2.5 font-display text-[12px] font-semibold uppercase tracking-[0.14em] text-white transition hover:opacity-90"
              >
                Open Scout Dashboard <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BigStat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: "neutral" | "success" | "danger";
}) {
  const toneClass =
    tone === "success"
      ? "text-[hsl(var(--state-success))]"
      : tone === "danger"
        ? "text-[hsl(var(--state-danger))]"
        : "text-white";
  return (
    <div className="rounded-lg bg-white/[0.03] p-2.5 ring-1 ring-white/[0.05]">
      <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-white/45">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 font-display text-[20px] font-semibold tabular-nums leading-none",
          toneClass,
        )}
      >
        {value}
      </div>
      {hint && <p className="mt-1 font-mono text-[9.5px] leading-tight text-white/35">{hint}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1.5 font-display text-[10px] font-semibold uppercase tracking-[0.18em] text-white/50">
        {title}
      </h4>
      {children}
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return (
    <p className="rounded-md bg-white/[0.02] px-3 py-2 text-center text-[11px] text-white/45">
      {text}
    </p>
  );
}

function SymbolRow({ r }: { r: ScoutReport }) {
  const s = r.signal?.scores;
  const dir = s?.direction ?? "neutral";
  const DirIcon = dir === "long" ? ArrowUp : dir === "short" ? ArrowDown : Radar;
  const dirTone =
    dir === "long"
      ? "text-[hsl(var(--state-success))]"
      : dir === "short"
        ? "text-[hsl(var(--state-danger))]"
        : "text-white/40";
  return (
    <li className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2.5 py-1.5 ring-1 ring-white/[0.04]">
      <span className="text-[12px] font-semibold text-white">{r.symbol}</span>
      {s && (
        <span
          className={cn("flex items-center gap-0.5 text-[10.5px] font-bold uppercase", dirTone)}
        >
          <DirIcon className="h-3 w-3" />
          {dir === "neutral" ? "flat" : dir}
        </span>
      )}
      <span className="font-mono text-[10px] uppercase tracking-wider text-white/40">
        {s?.recommendation ?? "—"}
      </span>
      <span className="ml-auto font-display text-[13px] tabular-nums text-white">
        {s?.movement != null ? Math.round(s.movement) : "—"}
      </span>
      <span className="font-mono text-[9.5px] uppercase text-white/35">mv</span>
    </li>
  );
}

/* --------- real aggregation from the current Scout scan --------- */

interface Aggregated {
  up: number;
  down: number;
  blocked: number;
  offense: number;
  offenseWired: boolean;
  best: ScoutReport[];
  blockedList: { symbol: string; reason: string }[];
}

function computeStats(reports: ScoutReport[]): Aggregated {
  let up = 0,
    down = 0,
    blocked = 0,
    offense = 0;
  const blockedList: { symbol: string; reason: string }[] = [];

  for (const r of reports) {
    const s = r.signal?.scores;
    if (!s) continue;
    if (s.trend === "up") up++;
    else if (s.trend === "down") down++;

    if (s.recommendation === "accumulator" && s.direction !== "neutral") {
      const aligned =
        (s.trend === "up" && s.direction === "long") ||
        (s.trend === "down" && s.direction === "short");
      if (aligned) offense++;
      else {
        blocked++;
        blockedList.push({
          symbol: r.symbol,
          reason: `${s.direction} vs ${s.trend} trend`,
        });
      }
    } else if (s.recommendation === "hunter") {
      offense++;
    }
  }

  const best = reports
    .filter((r) => r.signal && r.signal.scores.recommendation !== "sit-out")
    .sort((a, b) => (b.signal!.scores.movement ?? 0) - (a.signal!.scores.movement ?? 0))
    .slice(0, 5);

  // "offense" here is derived from current scan candidates, not confirmed
  // deliveries to Onyx — until that pipe is wired, keep it honest.
  const offenseWired = false;

  return { up, down, blocked, offense, offenseWired, best, blockedList };
}
