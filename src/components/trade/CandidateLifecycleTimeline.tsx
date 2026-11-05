// Compact lifecycle timeline for the active candidate. Presentational only:
// every stage shown is one the server proved from persisted facts.

import type { CandidateLifecycleDto, LifecycleStage } from "@/lib/candidate/lifecycle";

const STAGE_LABEL: Record<LifecycleStage, string> = {
  candidate_created: "Candidate",
  technical_validated: "Technical ✓",
  technical_rejected: "Technical ✗",
  // "not asked" and "asked, nobody answered" are different facts. Neither is
  // ever a verdict, and neither gates execution.
  ai_shadow_pending: "AI not asked",
  ai_shadow_evaluated: "AI evaluated",
  ai_shadow_unavailable: "AI unavailable",
  execution_approved: "Approved",
  execution_rejected: "Rejected",
  order_submitted: "Submitted",
  order_failed: "Order failed",
  filled: "Filled",
  cancelled: "Cancelled",
  closed: "Closed",
};

const NEGATIVE: ReadonlySet<LifecycleStage> = new Set<LifecycleStage>([
  "technical_rejected",
  "execution_rejected",
  "order_failed",
  "cancelled",
]);

function stageColor(stage: LifecycleStage): string {
  if (NEGATIVE.has(stage)) return "var(--onixus-red)";
  if (stage === "ai_shadow_pending" || stage === "ai_shadow_unavailable") return "#FFD24A";
  return "var(--onixus-teal)";
}

export function CandidateLifecycleTimeline({
  lifecycle,
  freshness,
  isLoading,
}: {
  lifecycle: CandidateLifecycleDto | null;
  freshness: "current" | "stale" | null;
  isLoading: boolean;
}) {
  return (
    <section
      className="rounded-2xl border border-white/[0.08] bg-black p-3"
      data-testid="candidate-lifecycle"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-mono text-[11px] uppercase tracking-wider text-white/55">
          Candidate lifecycle
        </h3>
        {freshness ? (
          <span
            className="rounded border px-1.5 py-px font-mono text-[9px] uppercase tracking-wider"
            style={{
              borderColor: freshness === "current" ? "rgba(20,241,149,0.4)" : "rgba(255,210,74,0.4)",
              color: freshness === "current" ? "var(--onixus-teal)" : "#FFD24A",
            }}
          >
            {freshness === "current" ? "Current" : "Historical"}
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <p className="mt-3 text-[11px] text-white/40">Loading candidate…</p>
      ) : !lifecycle ? (
        <p className="mt-3 text-[11px] text-white/40">
          No candidate detected for this symbol yet.
        </p>
      ) : (
        <>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-wide text-white/40">
            {lifecycle.candidate.strategy} · {lifecycle.candidate.direction} ·{" "}
            {lifecycle.candidate.timeframe} ·{" "}
            {new Date(lifecycle.candidate.candleCloseAt)
              .toISOString()
              .slice(0, 16)
              .replace("T", " ")}{" "}
            UTC
          </p>
          <ol className="mt-2 flex flex-wrap items-center gap-1">
            {lifecycle.states.map((stage) => (
              <li
                key={stage}
                className="rounded border px-1.5 py-px font-mono text-[9px] uppercase tracking-wider"
                style={{ borderColor: "rgba(255,255,255,0.12)", color: stageColor(stage) }}
              >
                {STAGE_LABEL[stage]}
              </li>
            ))}
          </ol>
          <p className="mt-2 font-mono text-[9px] text-white/30">
            {lifecycle.candidate.candidateId}
            {lifecycle.orderState ? ` · intent ${lifecycle.orderState}` : " · no order intent"}
          </p>
        </>
      )}
    </section>
  );
}
