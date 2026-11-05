/**
 * ShortlistPanel — the real, persisted committee funnel for the current cycle.
 *
 * Reads `committee_cycles` + `committee_shortlist` through a read-only server
 * function. Shows candidate → strategist opinions → ONYX rank → entry plan
 * (PENDING ENTRY for resting limits) → rejection reason. Advisory only.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getShortlistCycle, type ShortlistRowDto } from "@/lib/ai/shortlist.functions";
import { roleShort } from "@/lib/ai/committee/roles";
import type { CommitteeRole } from "@/lib/ai/committee/schema";
import { cn } from "@/lib/utils";

const fmt = (n: number | null, d = 3) => (n == null ? "—" : n.toFixed(d));

function stateTone(row: ShortlistRowDto): { label: string; cls: string } {
  if (row.selected) {
    const type = row.entryPlan?.entryType;
    return type === "limit"
      ? { label: "Pending entry", cls: "text-[color:var(--accent)] border-[color:var(--accent)]/40" }
      : { label: "Selected", cls: "text-[color:var(--positive)] border-[color:var(--positive)]/40" };
  }
  if (row.state === "rejected") return { label: "Rejected", cls: "text-white/45 border-white/10" };
  if (row.state === "degraded") return { label: "Degraded", cls: "text-amber-300 border-amber-400/30" };
  return { label: "Reviewing", cls: "text-white/70 border-white/15" };
}

export function ShortlistPanel({ book = "paper" }: { book?: "paper" | "live" }) {
  const fetchCycle = useServerFn(getShortlistCycle);
  const q = useQuery({
    queryKey: ["committee-shortlist", book],
    queryFn: () => fetchCycle({ data: { book } }),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);

  return (
    <section className="rounded-2xl border border-white/[0.08] bg-black p-4 sm:p-5">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-white/50">
            Committee shortlist
          </p>
          <h3 className="mt-1 truncate font-display text-[15px] font-semibold uppercase tracking-[0.08em] text-white">
            {q.data?.cycleKey ?? "No cycle yet"}
          </h3>
        </div>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
          {q.data
            ? `${q.data.universeSize ?? 0} universe · ${q.data.candidateCount ?? 0} candidates · ${q.data.status ?? "—"}`
            : "—"}
        </p>
      </header>

      {q.isLoading ? (
        <p className="text-[12px] text-white/50">Loading cycle…</p>
      ) : rows.length === 0 ? (
        <p className="text-[12px] text-white/50">
          {q.data?.noTradeReason
            ? `No shortlist rows — ${q.data.noTradeReason.replace(/_/g, " ")}.`
            : "No persisted shortlist for this book yet."}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <ShortlistRow key={r.id} row={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ShortlistRow({ row }: { row: ShortlistRowDto }) {
  const tone = stateTone(row);
  const plan = row.entryPlan;
  const objection = row.riskObjection;
  const numOf = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  return (
    <li className="rounded-xl border border-white/[0.07] bg-white/[0.015] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-[10px] tabular-nums text-white/35">
            #{row.rank ?? "—"}
          </span>
          <span className="truncate font-display text-[13px] font-semibold uppercase tracking-[0.1em] text-white">
            {row.symbol}
          </span>
          {row.direction && (
            <span
              className={cn(
                "font-mono text-[10px] uppercase tracking-[0.16em]",
                row.direction === "long"
                  ? "text-[color:var(--positive)]"
                  : "text-[color:var(--negative)]",
              )}
            >
              {row.direction}
            </span>
          )}
        </div>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em]",
            tone.cls,
          )}
        >
          {tone.label}
        </span>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Cell label="ONYX score" value={fmt(row.score)} />
        <Cell label="Net edge" value={row.netEdgeBps == null ? "—" : `${row.netEdgeBps.toFixed(1)} bps`} />
        <Cell label="Entry" value={plan ? String(plan.entryType ?? "—") : "—"} />
        <Cell
          label="Stop"
          value={plan ? `${fmt(numOf(plan.stopAtrMultiple), 2)}× ATR` : "—"}
        />
      </dl>

      {row.seats.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-white/[0.05] pt-2">
          {row.seats.map((s) => (
            <li key={s.role} className="font-mono text-[10px] text-white/60">
              <span className="text-white/40">{roleShort(s.role as CommitteeRole) ?? s.role}: </span>
              {s.available ? `${s.direction ?? "—"} ${s.confidence?.toFixed(2) ?? ""}` : "unavailable"}
            </li>
          ))}
        </ul>
      )}

      {objection?.objected === true && (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-amber-300/80">
          Risk {String(objection.classification ?? "")} ·{" "}
          {objection.veto === true ? "veto" : `penalty ${fmt(numOf(objection.penalty), 2)}`}
        </p>
      )}

      {row.rejectionReason && (
        <p className="mt-1 font-mono text-[10px] text-white/40">
          {row.rejectionReason.replace(/_/g, " ")}
        </p>
      )}
    </li>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[9px] font-semibold uppercase tracking-wider text-white/35">{label}</dt>
      <dd className="mt-0.5 font-mono text-[12px] tabular-nums text-white/85">{value}</dd>
    </div>
  );
}
