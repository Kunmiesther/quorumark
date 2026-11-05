// Live activity rail — most recent persisted committee evaluations.
//
// Read-only. Every row is an event that actually happened; there is no
// simulated "thinking" state and nothing here can act on a trade.

import { ROLES } from "@/lib/ai/committee/schema";
import type { CommitteeEvaluationDto } from "@/lib/ai/committee/dto";
import { agoLabel } from "@/lib/onyx/committeeSynthesis";

const VERDICT_TONE: Record<string, string> = {
  shadow_endorse: "var(--onixus-teal)",
  shadow_weak_endorse: "#FFD24A",
  shadow_reject: "var(--onixus-red)",
  shadow_no_consensus: "rgba(230,232,240,0.7)",
  shadow_unavailable: "rgba(230,232,240,0.4)",
};

export function LiveActivityRail({
  evaluations,
  isLoading = false,
  nowMs,
}: {
  evaluations: CommitteeEvaluationDto[];
  isLoading?: boolean;
  nowMs: number;
}) {
  return (
    <section
      className="rounded-2xl border border-white/[0.08] bg-black p-3"
      data-testid="live-activity-rail"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-mono text-[11px] uppercase tracking-wider text-white/55">
          Live activity · candidate → seats → ONYX
        </h3>
        <span className="font-mono text-[9px] uppercase tracking-wider text-white/30">
          {evaluations.length} recorded events
        </span>
      </div>

      {isLoading && !evaluations.length ? (
        <p className="mt-3 text-[11px] text-white/40">Loading activity…</p>
      ) : !evaluations.length ? (
        <p className="mt-3 text-[11px] text-white/40">No evaluations in the last 7 days.</p>
      ) : (
        <ol className="mt-2 space-y-1">
          {evaluations.map((e, idx) => {
            const answered = e.outcomes.filter((o) => o.available).length;
            return (
              <li
                key={`${e.candidateId}-${e.candleCloseAt}`}
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-white/[0.05] py-1.5 first:border-t-0"
              >
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{
                    background: VERDICT_TONE[e.verdict] ?? "rgba(230,232,240,0.4)",
                    boxShadow: idx === 0 ? `0 0 8px ${VERDICT_TONE[e.verdict]}` : undefined,
                  }}
                />
                <span className="font-mono text-[11px] text-white/80">{e.symbol}</span>
                <span className="font-mono text-[10px] text-white/40">{e.strategy}</span>
                <span className="font-mono text-[10px] text-white/50">
                  {answered}/{ROLES.length} seats
                </span>
                <span
                  className="font-mono text-[10px] uppercase"
                  style={{ color: VERDICT_TONE[e.verdict] }}
                >
                  {e.verdict.replace("shadow_", "").replace("_", " ")}
                </span>
                <span className="font-mono text-[10px] text-white/40">
                  {e.consensusDirection ?? "—"}
                  {e.consensusConfidence != null
                    ? ` ${Math.round(e.consensusConfidence * 100)}%`
                    : ""}
                </span>
                <span className="ml-auto font-mono text-[9px] text-white/30">
                  {agoLabel(e.candleCloseAt, nowMs)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
