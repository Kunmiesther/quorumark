// SHADOW committee panel — three independent seats plus deterministic ONYX
// synthesis. Purely informational: no mutation path, no order controls.

import { useEffect, useState } from "react";
import type { CommitteeEvaluationDto, ShadowVerdict } from "@/lib/ai/committee/dto";
import { ROLES, type CommitteeRole, type ProviderOutcome, type UnavailableReason } from "@/lib/ai/committee/schema";
import {
  agoLabel,
  onyxEvaluationSynthesis,
  verdictOutcome,
} from "@/lib/onyx/committeeSynthesis";
import { EVALUATION_CADENCE_MS } from "@/hooks/useIntelligenceFeed";
import {
  ONYX_IDENTITY,
  aiCollectiveState,
  roleName,
  roleRemit,
  aiStateLabel,
  participationLabel,
} from "@/lib/ai/committee/roles";
import { useIsOwner } from "@/hooks/useIsOwner";



const VERDICT_COPY: Record<ShadowVerdict, { label: string; color: string }> = {
  shadow_endorse: { label: "ENDORSE", color: "var(--onixus-teal)" },
  shadow_weak_endorse: { label: "WEAK ENDORSE", color: "#FFD24A" },
  shadow_reject: { label: "REJECT", color: "var(--onixus-red)" },
  shadow_no_consensus: { label: "NO CONSENSUS", color: "rgba(230,232,240,0.7)" },
  shadow_unavailable: { label: "UNAVAILABLE", color: "rgba(230,232,240,0.45)" },
};

const REASON_COPY: Record<UnavailableReason, string> = {
  missing_credential: "credential not configured",
  timeout: "timed out",
  http_error: "provider error",
  malformed_json: "malformed response",
  schema_invalid: "schema mismatch",
  empty_response: "empty response",
  stale_snapshot: "snapshot too old",
  invalid_model_config: "model id misconfigured",
};

function dirColor(dir: string | null | undefined): string {
  if (dir === "long") return "var(--onixus-teal)";
  if (dir === "short") return "var(--onixus-red)";
  return "rgba(230,232,240,0.6)";
}

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function SeatCard({
  role,
  outcome,
  candleCloseAt,
  showTechnical,
}: {
  role: CommitteeRole;
  outcome: ProviderOutcome | undefined;
  candleCloseAt: string;
  showTechnical: boolean;
}) {

  const healthy = outcome?.available === true;
  const dot = !outcome ? "rgba(230,232,240,0.25)" : healthy ? "var(--onixus-teal)" : "var(--onixus-red)";
  return (
    <div
      className="rounded-xl border border-white/[0.08] bg-white/[0.015] p-2.5"
      data-testid={`committee-seat-${role}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: dot, boxShadow: healthy ? `0 0 6px ${dot}` : undefined }}
            />
            <span className="font-mono text-[10px] uppercase tracking-wider text-white/60">
              {roleName(role)}
            </span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[9px] text-white/25">
            {roleRemit(role)} · {outcome ? (healthy ? "available" : "degraded") : "not asked"}
          </div>
        </div>
        <div className="shrink-0 text-right">
          {outcome?.available ? (
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
            <div className="font-mono text-[10px] text-white/30">
              {outcome ? "unavailable" : "not asked"}
            </div>
          )}
        </div>
      </div>

      {outcome?.available ? (
        <>
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.round(outcome.response.confidence * 100)}%`,
                background: dirColor(outcome.response.direction),
              }}
            />
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-white/70">{outcome.response.summary}</p>
          {outcome.response.risk_flags.length ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {outcome.response.risk_flags.slice(0, 4).map((f) => (
                <span
                  key={f}
                  className="rounded border border-white/10 px-1 py-px font-mono text-[9px] text-white/55"
                >
                  {f}
                </span>
              ))}
            </div>
          ) : null}
        </>
      ) : outcome ? (
        <p className="mt-1.5 text-[11px] text-white/40">
          {REASON_COPY[outcome.reason] ?? outcome.reason}
          {outcome.detail ? ` — ${outcome.detail}` : ""}
        </p>
      ) : (
        <p className="mt-1.5 text-[11px] text-white/35">
          No opinion recorded for this candle.
        </p>
      )}

      <p className="mt-1.5 font-mono text-[9px] text-white/25">
        {new Date(candleCloseAt).toISOString().slice(11, 16)} UTC candle
      </p>

      {showTechnical && outcome ? (
        <details className="mt-1">
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

export function CommitteePanel({
  symbol,
  evaluation,
  isLoading = false,
}: {
  symbol: string;
  /** Latest persisted evaluation from the committee ledger. */
  evaluation: CommitteeEvaluationDto | null;
  isLoading?: boolean;
}) {
  const now = useNow();
  const { isOwner } = useIsOwner();
  const row = evaluation;
  const vc = row ? VERDICT_COPY[row.verdict] : null;

  const closeMs = row ? Date.parse(row.candleCloseAt) : NaN;
  const countdown = Number.isFinite(closeMs)
    ? Math.max(0, Math.round((closeMs + EVALUATION_CADENCE_MS - now) / 1000))
    : null;

  return (
    <section
      className="rounded-2xl border border-white/[0.08] bg-black p-3"
      data-testid="committee-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-mono text-[11px] uppercase tracking-wider text-white/55">
          AI · {symbol}
        </h3>
        <div className="flex items-center gap-2">
          {row ? (
            <span
              className="rounded border border-white/10 px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-white/60"
              data-testid="ai-participation"
            >
              {aiStateLabel(
                aiCollectiveState({
                  asked: row.outcomes.length,
                  available: row.outcomes.filter((o) => o.available).length,
                  pending: isLoading,
                }),
              )}{" · "}
              {participationLabel(
                row.outcomes.filter((o) => o.available).length,
                row.outcomes.length,
              )}
            </span>
          ) : null}
          {row ? (
            <span className="font-mono text-[9px] uppercase tracking-wider text-white/35">
              updated {agoLabel(row.candleCloseAt, now)}
              {countdown != null ? ` · next in ${countdown}s` : ""}
            </span>
          ) : null}
          <span
            className="rounded border px-1.5 py-px font-mono text-[9px] uppercase tracking-wider"
            style={{
              borderColor: "rgba(255,210,74,0.4)",
              color: "#FFD24A",
              background: "rgba(255,210,74,0.06)",
            }}
          >
            Shadow
          </span>
        </div>
      </div>

      <p className="mt-1 font-mono text-[9px] uppercase tracking-wide text-white/35">
        Shadow analysis — does not control live trading
      </p>

      {isLoading && !row ? (
        <p className="mt-3 text-[11px] text-white/40">Loading evaluations…</p>
      ) : !row ? (
        <p className="mt-3 text-[11px] text-white/40">
          No AI review persisted for {symbol} in the last 7 days.
        </p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
            <span
              className="font-mono text-[13px] font-semibold tracking-wide"
              style={{ color: vc?.color }}
            >
              {vc?.label ?? row.verdict}
            </span>
            <span className="font-mono text-[10px] text-white/40">
              {row.strategy} · {row.timeframe} · {row.consensusDirection ?? "—"}
              {row.consensusConfidence != null
                ? ` · ${Math.round(row.consensusConfidence * 100)}%`
                : ""}
            </span>
          </div>

          <div className="mt-2.5 grid gap-2 md:grid-cols-3">
            {ROLES.map((role) => (
              <SeatCard
                key={role}
                role={role}
                outcome={row.outcomes.find((o) => o.role === role)}
                candleCloseAt={row.candleCloseAt}
                showTechnical={isOwner}
              />
            ))}
          </div>

          <div
            className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-2.5"
            data-testid="onyx-synthesis"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] uppercase tracking-wider text-white/60">
                {ONYX_IDENTITY.decision}
              </span>
              <span className="font-mono text-[9px] uppercase tracking-wider text-white/30">
                deterministic synthesis — not a model
              </span>
            </div>
            <p className="mt-1 text-[11.5px] leading-snug text-white/75">
              {onyxEvaluationSynthesis(row)}
            </p>
            <p className="mt-1.5 font-mono text-[10px]" style={{ color: vc?.color }}>
              {verdictOutcome(row)}
            </p>
          </div>

          <p className="mt-2 font-mono text-[9px] text-white/30">
            {row.candidateId} · {row.promptVersion ?? "prompt.?"} ·{" "}
            {row.scorerVersion ?? "scorer.?"} ·{" "}
            {new Date(row.candleCloseAt).toISOString().slice(0, 16).replace("T", " ")} UTC
            {row.totalLatencyMs != null ? ` · ${row.totalLatencyMs} ms total` : ""}
          </p>
        </>
      )}
    </section>
  );
}
