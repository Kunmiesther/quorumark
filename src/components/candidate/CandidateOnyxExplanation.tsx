// Onyx explanation of ONE selected candidate.
//
// AUTHORITY: NONE. This panel renders the validated lifecycle DTO for the
// selected candidate id. It never recomputes a verdict, never invents a
// missing value, never exposes chain-of-thought, and has no mutation path.

import type { CandidateLifecycleDto } from "@/lib/candidate/lifecycle";
import type { CommitteeEvaluationDto } from "@/lib/ai/committee/dto";
import type { ProviderOutcome } from "@/lib/ai/committee/schema";
import { aiReviewLabel } from "@/lib/ai/committee/roles";
import { useIsOwner } from "@/hooks/useIsOwner";
import { deterministicExplanation, onyxSynthesis } from "@/lib/onyx/candidateSynthesis";
import {
  agoLabel,
  onyxEvaluationSynthesis,
  verdictOutcome,
} from "@/lib/onyx/committeeSynthesis";

function dirColor(dir: string | null | undefined): string {
  if (dir === "long") return "var(--onixus-teal)";
  if (dir === "short") return "var(--onixus-red)";
  return "rgba(230,232,240,0.6)";
}

function Seat({
  outcome,
  index,
  showTechnical,
}: {
  outcome: ProviderOutcome;
  index: number;
  showTechnical: boolean;
}) {
  return (
    <div className="border-t border-white/[0.06] py-2 first:border-t-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-wider text-white/45">
            {aiReviewLabel(index)}
          </div>
        </div>

        <div className="shrink-0 text-right">
          {outcome.available ? (
            <>
              <div
                className="font-mono text-[11px] font-semibold uppercase"
                style={{ color: dirColor(outcome.response.direction) }}
              >
                {outcome.response.direction}
              </div>
              <div className="font-mono text-[10px] text-white/45">
                {Math.round(outcome.response.confidence * 100)}%
              </div>
            </>
          ) : (
            <div className="font-mono text-[11px] text-white/30">Unavailable</div>
          )}
        </div>
      </div>
      {outcome.available ? (
        <p className="mt-1 text-[11px] text-white/70">{outcome.response.summary}</p>
      ) : (
        <p className="mt-1 text-[11px] text-white/40">{outcome.reason}</p>
      )}
      {outcome.available && outcome.response.risk_flags.length ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {outcome.response.risk_flags.slice(0, 6).map((f) => (
            <span
              key={f}
              className="rounded border border-white/10 px-1 py-px font-mono text-[9px] text-white/55"
            >
              {f}
            </span>
          ))}
        </div>
      ) : null}
      {showTechnical ? (
        <details className="mt-1.5">
          <summary className="cursor-pointer font-mono text-[9px] uppercase tracking-wider text-white/25">
            Technical details
          </summary>
          <div className="mt-1 font-mono text-[9px] text-white/35">
            {outcome.provider} · {outcome.model} · {outcome.latencyMs} ms
          </div>
        </details>
      ) : null}
    </div>
  );
}


export function CandidateOnyxExplanation({
  lifecycle,
  isLoading,
  fallbackEvaluation = null,
  nowMs,
}: {
  lifecycle: CandidateLifecycleDto | null;
  isLoading: boolean;
  /**
   * Latest persisted committee evaluation for the desk symbol. Used only when
   * no candidate lifecycle row is selected — the autonomous sweep writes
   * evaluations keyed on decision ids, which have no `strategy_candidates` row.
   */
  fallbackEvaluation?: CommitteeEvaluationDto | null;
  nowMs?: number;
}) {
  const { isOwner } = useIsOwner();
  const ev = lifecycle?.evaluation ?? fallbackEvaluation;
  const now = nowMs ?? Date.now();
  return (
    <section
      className="rounded-2xl border border-white/[0.08] bg-black p-3"
      data-testid="onyx-candidate-explanation"
      data-candidate-id={lifecycle?.candidate.candidateId ?? ev?.candidateId ?? ""}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-mono text-[11px] uppercase tracking-wider text-white/55">
          Onyx · candidate explanation
        </h3>
        <span
          className="rounded border px-1.5 py-px font-mono text-[9px] uppercase tracking-wider"
          style={{ borderColor: "rgba(255,210,74,0.4)", color: "#FFD24A" }}
        >
          Shadow analysis — does not control live trading
        </span>
      </div>

      {isLoading && !lifecycle && !ev ? (
        <div className="mt-3 space-y-2" data-testid="onyx-skeleton">
          <div className="h-3 w-2/3 animate-pulse rounded bg-white/[0.06]" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-white/[0.06]" />
        </div>
      ) : !lifecycle && ev ? (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="rounded border border-white/15 px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-white/70">
              {ev.symbol} · {ev.strategy} · {ev.timeframe}
            </span>
            <span className="font-mono text-[9px] uppercase tracking-wider text-white/40">
              candle {new Date(ev.candleCloseAt).toISOString().slice(11, 16)} UTC ·{" "}
              {agoLabel(ev.candleCloseAt, now)}
            </span>
          </div>
          <p className="mt-2 text-[11.5px] text-white/75">{onyxEvaluationSynthesis(ev)}</p>
          <div className="mt-3">
            {ev.outcomes.length ? (
              ev.outcomes.map((o, i) => (
                <Seat key={o.role} outcome={o} index={i} showTechnical={isOwner} />
              ))
            ) : (
              <p className="text-[11px] text-white/40">No provider opinions recorded yet.</p>
            )}
          </div>
          <p className="mt-2 font-mono text-[10px]" style={{ color: "#FFD24A" }}>
            {verdictOutcome(ev)}
          </p>
          <p className="mt-2 font-mono text-[9px] text-white/25">
            {ev.candidateId} · {ev.verdict} · {ev.promptVersion ?? "prompt.?"} ·{" "}
            {ev.scorerVersion ?? "scorer.?"}
          </p>
        </>
      ) : !lifecycle ? (
        <p className="mt-3 text-[11px] text-white/40">
          Select a candidate in Scout to see its explanation.
        </p>
      ) : (

        <>
          <p className="mt-2 text-[11.5px] text-white/75">
            {deterministicExplanation(lifecycle)}
          </p>

          <div className="mt-3">
            {ev && ev.outcomes.length ? (
              ev.outcomes.map((o, i) => (
                <Seat key={o.role} outcome={o} index={i} showTechnical={isOwner} />
              ))
            ) : (
              <p className="text-[11px] text-white/40">No provider opinions recorded yet.</p>
            )}
          </div>

          <p className="mt-3 text-[11.5px] text-white/70">{onyxSynthesis(lifecycle)}</p>

          <p className="mt-2 font-mono text-[9px] text-white/25">
            {lifecycle.candidate.candidateId}
            {ev
              ? ` · ${ev.verdict} · ${ev.promptVersion ?? "prompt.?"} · ${ev.scorerVersion ?? "scorer.?"}`
              : ""}
            {ev?.schemaVersion ? ` · ${ev.schemaVersion}` : ""}
          </p>
        </>
      )}
    </section>
  );
}
