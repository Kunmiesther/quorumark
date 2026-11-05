/**
 * LifeMapStatsCard — Card 2 of the Trade intelligence row.
 *
 * Reuses the existing `getLifeMapSnapshot` server function (same selector used
 * by LifeProgressCard / BillsPromptCard / /life-map). No parallel state, no
 * recompute — this card just projects the shared snapshot into a compact
 * stat layout suited for the 3-across intel row.
 *
 * Copy rule (see docs/LIFE_MAP_CONSOLIDATION.md): Life Map surfaces say
 * "Covered", never "paid" / "verified paid".
 */
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { SurfaceCard } from "@/components/phantom/SurfaceCard";
import { getLifeMapSnapshot } from "@/lib/bills/bills.functions";

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}
function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export function LifeMapStatsCard() {
  const fetchSnap = useServerFn(getLifeMapSnapshot);
  const snapQ = useQuery({
    queryKey: ["life-map-snapshot"],
    queryFn: () => fetchSnap(),
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  const snap = snapQ.data;
  const totalAmount = snap?.total_amount_usd ?? 0;
  const totalCovered = snap?.total_covered_usd ?? 0;
  const remaining = Math.max(0, totalAmount - totalCovered);
  const coveragePct =
    totalAmount > 0 ? Math.min(100, (totalCovered / totalAmount) * 100) : 0;
  const hasBills = (snap?.bills?.length ?? 0) > 0;

  const nextBill = (() => {
    const rows = snap?.bills ?? [];
    const upcoming = rows
      .map((r) => ({
        name: r.bill.name,
        gap: Math.max(0, Number(r.bill.amount_usd) - r.covered_usd),
        due_day: r.bill.due_day ?? null,
      }))
      .filter((b) => b.gap > 0);
    const withDue = upcoming
      .filter((b): b is typeof b & { due_day: number } => b.due_day != null)
      .sort((a, b) => a.due_day - b.due_day);
    return withDue[0] ?? upcoming[0] ?? null;
  })();

  return (
    <SurfaceCard
      as="section"
      className="flex h-full flex-col overflow-hidden p-5"
    >
      <header className="mb-4 flex items-baseline justify-between gap-3">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-white/45">
          Life Map · Covered
        </p>
        <Link
          to="/life-map"
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-white/10 px-2 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.18em] text-white/60 transition hover:bg-white/[0.06] hover:text-white"
        >
          Open <ArrowRight className="h-3 w-3" />
        </Link>
      </header>

      <div className="mb-4">
        <p
          className="text-[36px] font-semibold leading-none tabular-nums"
          style={{ color: hasBills ? "#14F195" : "rgba(255,255,255,0.55)" }}
        >
          {hasBills ? `${Math.round(coveragePct)}%` : "—"}
        </p>
        <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
          coverage
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 border-y border-white/5 py-4">
        <Stat
          label="Covered"
          value={hasBills ? fmtUsd(totalCovered) : "—"}
        />
        <Stat
          label="Remaining"
          value={hasBills ? fmtUsd(remaining) : "—"}
        />
      </div>


      {/* Priority-ordered coverage list. The snapshot query orders bills by
          `priority ASC` (matching the allocation engine order), so we render
          rows as-is. */}
      <div
        data-testid="lifemap-priority-list"
        className="-mr-1 mt-4 flex min-h-0 flex-1 flex-col divide-y divide-white/[0.05] overflow-y-auto pr-1"
      
      >
        {hasBills ? (
          (snap?.bills ?? []).slice(0, 8).map((r, idx) => {
            const target = Number(r.bill.amount_usd);
            const covered = Math.min(r.covered_usd, target);
            const rem = Math.max(0, target - covered);
            const pct = target > 0 ? Math.min(100, (covered / target) * 100) : 0;
            const full = pct >= 100;
            return (
              <div
                key={r.bill.id}
                data-testid={`lifemap-priority-row-${idx}`}
                className="py-2"
              >
                <div className="flex items-baseline gap-2">
                  <span className="w-5 shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/35 tabular-nums">
                    {String(idx + 1).padStart(2, "0")}
                  </span>
                  <p className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-white">
                    {r.bill.name}
                  </p>
                  <p
                    className="shrink-0 font-mono text-[10px] tabular-nums"
                    style={{ color: full ? "#14F195" : "rgba(255,255,255,0.7)" }}
                  >
                    {Math.round(pct)}%
                  </p>
                </div>
                <div className="ml-7 mt-1 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className="h-full rounded-full transition-[width]"
                    style={{
                      width: `${pct}%`,
                      background: full ? "#14F195" : "rgba(255,255,255,0.55)",
                    }}
                  />
                </div>
                <p className="ml-7 mt-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-white/40 tabular-nums">
                  {fmtUsd(covered)} covered · {fmtUsd(rem)} remaining ·{" "}
                  {fmtUsd(target)} target
                </p>
              </div>
            );
          })
        ) : (
          <p className="py-3 font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
            Add bills to see coverage priority.
          </p>
        )}
      </div>

      <footer className="mt-4 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
        <span className="truncate">
          {nextBill
            ? `next · ${nextBill.name} · ${fmtUsd(nextBill.gap)}${
                nextBill.due_day != null ? ` · ${ordinal(nextBill.due_day)}` : ""
              }`
            : hasBills
              ? "all bills covered"
              : "no bills set"}
        </span>
      </footer>
    </SurfaceCard>
  );
}


function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.18em] text-white/45">
        {label}
      </p>
      <p className="mt-1 truncate text-[15px] font-semibold tabular-nums text-white">
        {value}
      </p>
    </div>
  );
}
