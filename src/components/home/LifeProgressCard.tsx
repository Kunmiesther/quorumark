/**
 * LifeProgressCard — Home Life Map summary.
 *
 * Visual contract: matches the Home StatCard trio (Total Equity / Cash /
 * Allocated). Uses SurfaceCard tiles — no borders, rounded-3xl, white/[0.06]
 * fill, mono uppercase micro-labels (11px, tracking-0.16em, white/45), and
 * 36px bold Rajdhani numbers (tabular-nums, letter-spacing -0.02em).
 *
 * Data source: `getLifeMapSnapshot` + `listBills`. Copy: "Covered", never
 * "paid". Paper disclaimer preserved.
 */
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowRight, Target, PiggyBank, TrendingUp } from "lucide-react";
import { SurfaceCard } from "@/components/phantom/SurfaceCard";
import {
  getLifeMapSnapshot,
  listBills,
} from "@/lib/bills/bills.functions";

const PURPLE = "#9945FF";
const TEAL = "#14F195";

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export function LifeProgressCard() {
  const fetchSnap = useServerFn(getLifeMapSnapshot);
  const fetchBills = useServerFn(listBills);

  const snapQ = useQuery({
    queryKey: ["life-map-snapshot"],
    queryFn: () => fetchSnap(),
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const billsQ = useQuery({
    queryKey: ["bills"],
    queryFn: () => fetchBills(),
    staleTime: 10_000,
  });

  if (snapQ.isError) {
    return (
      <SurfaceCard>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[14px] text-white/70">
            Life Map is unavailable — trading unaffected.
          </p>
          <Link
            to="/life-map"
            className="text-[12px] font-semibold uppercase tracking-[0.16em] text-white/80 underline underline-offset-4 hover:text-white"
          >
            Open
          </Link>
        </div>
      </SurfaceCard>
    );
  }

  const snap = snapQ.data;
  const bills = billsQ.data ?? [];
  const totalAmount = snap?.total_amount_usd ?? 0;
  const totalCovered = snap?.total_covered_usd ?? 0;
  const remaining = Math.max(0, totalAmount - totalCovered);
  const coveragePct =
    totalAmount > 0 ? Math.min(100, (totalCovered / totalAmount) * 100) : 0;

  const coveredById = new Map(
    (snap?.bills ?? []).map((r) => [r.bill.id, r.covered_usd] as const),
  );
  const upcoming = bills
    .map((b) => {
      const covered = coveredById.get(b.id) ?? 0;
      return {
        id: b.id,
        name: b.name,
        amount: Number(b.amount_usd),
        gap: Math.max(0, Number(b.amount_usd) - covered),
        due_day: b.due_day ?? null,
      };
    })
    .filter((b) => b.gap > 0);
  const withDue = upcoming
    .filter((b): b is typeof b & { due_day: number } => b.due_day != null)
    .sort((a, b) => a.due_day - b.due_day);
  const nextBill = withDue[0] ?? upcoming[0] ?? null;

  const hasBills = bills.length > 0;
  const loading = snapQ.isLoading;

  const coveredValue = loading
    ? "—"
    : hasBills
      ? `${Math.round(coveragePct)}%`
      : "—";
  const remainingValue = loading ? "—" : hasBills ? fmtUsd(remaining) : "—";
  const periodValue = loading ? "—" : hasBills ? fmtUsd(totalCovered) : "—";

  return (
    <section aria-label="Life Progress" className="flex flex-col gap-4">
      {/* Header row — mirrors DesktopSectionHeader energy */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: PURPLE, boxShadow: `0 0 8px ${PURPLE}` }}
          />
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.18em] text-white/80">
            Life Progress
          </h2>
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/30">
            /
          </span>
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: TEAL }}
          >
            Live
          </span>
        </div>
        <Link
          to="/life-map"
          className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/80 transition hover:bg-white/[0.1] hover:text-white"
        >
          Manage bills <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {/* Tile trio — same grammar as Total Equity / Cash / Allocated */}
      <div className="grid grid-cols-12 gap-6">
        <StatTile
          className="col-span-12 md:col-span-4"
          label="Covered"
          value={coveredValue}
          hint={
            loading
              ? "Loading Life Map…"
              : hasBills
                ? `${fmtUsd(totalCovered)} of ${fmtUsd(totalAmount)}`
                : "No bills yet — set them up in Life Map"
          }
          icon={<Target className="h-4 w-4" />}
          accent
          progress={hasBills ? coveragePct : undefined}
        />
        <StatTile
          className="col-span-12 md:col-span-4"
          label="Remaining"
          value={remainingValue}
          hint={
            nextBill
              ? `Next: ${nextBill.name}${
                  nextBill.due_day != null
                    ? ` · due ${ordinal(nextBill.due_day)}`
                    : ""
                }`
              : hasBills
                ? "All bills covered this period"
                : "—"
          }
          icon={<PiggyBank className="h-4 w-4" />}
        />
        <StatTile
          className="col-span-12 md:col-span-4"
          label="Covered this period"
          value={periodValue}
          hint={
            `Paper simulation: ${fmtUsd(snap?.total_paper_covered_usd ?? 0)}; neither ledger is a bill payment.`
          }
          icon={<TrendingUp className="h-4 w-4" />}
          tone="teal"
        />
      </div>
    </section>
  );
}

function StatTile({
  label,
  value,
  hint,
  icon,
  className,
  accent,
  tone = "neutral",
  progress,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: React.ReactNode;
  className?: string;
  accent?: boolean;
  tone?: "neutral" | "teal";
  progress?: number;
}) {
  const valueColor =
    tone === "teal" ? TEAL : accent ? "#ffffff" : "rgba(255,255,255,0.95)";
  return (
    <SurfaceCard className={"flex flex-col gap-3 rounded-3xl " + (className ?? "")}>
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/45">
        {icon}
        {label}
      </div>
      <div
        className="text-[36px] font-bold leading-none tabular-nums"
        style={{ letterSpacing: "-0.02em", color: valueColor }}
      >
        {value}
      </div>
      {progress != null && (
        <div
          className="h-[3px] w-full overflow-hidden rounded-full bg-white/[0.06]"
          role="progressbar"
          aria-valuenow={Math.round(progress)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full transition-[width] duration-500"
            style={{
              width: `${Math.max(0, Math.min(100, progress))}%`,
              background: `linear-gradient(90deg, ${PURPLE} 0%, ${TEAL} 100%)`,
              boxShadow: `0 0 10px ${PURPLE}66`,
            }}
          />
        </div>
      )}
      {hint && <p className="truncate text-[12px] text-white/50">{hint}</p>}
    </SurfaceCard>
  );
}
