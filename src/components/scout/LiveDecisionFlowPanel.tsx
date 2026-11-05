/**
 * LiveDecisionFlowPanel — one direct flow, for one symbol:
 *
 *     MARKET  ->  DECISION  ->  SAFETY  ->  APEX
 *
 * Every value comes from a persisted record. Nothing is inferred, and a stage
 * with no proof renders gray ("not reached"), never green.
 *
 * The three AI seats are shown BESIDE the flow, not inside it, because they
 * are advisory: they cannot delay, approve, reject, size, sign or submit.
 * A seat that was never asked says so; a seat that was asked and did not
 * answer says that instead. Neither is ever counted as agreement.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Loader2,
  MinusCircle,
  XCircle,
} from "lucide-react";
import { CommandPanel } from "@/components/command/CommandPanel";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { aiReviewLabel } from "@/lib/ai/committee/roles";
import { useAuth } from "@/hooks/useAuth";
import { useLiveDecisionFlow } from "@/hooks/useLiveDecisionFlow";
import {
  FLOW_SYMBOLS,
  decisionAgeMs,
  formatAge,
  reasonProse,
  type FlowStatus,
  type FlowStep,
  type SeatView,
} from "@/lib/decision/decisionFlow";
import { workerStateLabel } from "@/lib/health/workerHealth";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<FlowStatus, { dot: string; text: string }> = {
  green: { dot: "bg-[#14F195]", text: "text-[#14F195]" },
  amber: { dot: "bg-amber-400", text: "text-amber-300" },
  red: { dot: "bg-red-500", text: "text-red-400" },
  gray: { dot: "bg-white/25", text: "text-white/45" },
};

const DIRECTION_STYLE: Record<string, string> = {
  long: "border-[#14F195]/50 bg-[#14F195]/10 text-[#14F195]",
  short: "border-red-500/50 bg-red-500/10 text-red-400",
  wait: "border-white/20 bg-white/5 text-white/70",
};



function StatusIcon({ status }: { status: FlowStatus }) {
  const cls = cn("h-4 w-4", STATUS_STYLE[status].text);
  if (status === "green") return <CheckCircle2 className={cls} />;
  if (status === "amber") return <AlertTriangle className={cls} />;
  if (status === "red") return <XCircle className={cls} />;
  return <CircleDashed className={cls} />;
}

function StepRow({ step, last }: { step: FlowStep; last: boolean }) {
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {!last && <span className="absolute left-[7px] top-5 h-full w-px bg-white/10" aria-hidden />}
      <span
        className={cn(
          "mt-1.5 h-[15px] w-[15px] shrink-0 rounded-full ring-4 ring-black",
          STATUS_STYLE[step.status].dot,
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <StatusIcon status={step.status} />
          <span className="font-display text-[12px] uppercase tracking-[0.14em] text-white/85">
            {step.label}
          </span>
          <span className={cn("text-[11px] font-semibold uppercase", STATUS_STYLE[step.status].text)}>
            {step.headline}
          </span>
        </div>
        <p className="mt-1 break-words text-[11.5px] leading-relaxed text-white/55">{step.detail}</p>
      </div>
    </li>
  );
}

function SafetyGrid({ checks }: { checks: SafetyCheckRow[] }) {
  return (
    <div className="space-y-1">
      <p className="text-[9.5px] uppercase tracking-[0.16em] text-white/40">Four safety checks</p>
      {checks.map((c) => (
        <div
          key={c.key}
          className="flex items-start justify-between gap-3 rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5"
        >
          <span className="min-w-0 text-[11px] text-white/65">{c.label}</span>
          <span
            className={cn(
              "shrink-0 text-[10.5px] font-semibold uppercase tracking-wider",
              c.passed === true && "text-[#14F195]",
              c.passed === false && "text-red-400",
              c.passed === null && "text-white/35",
            )}
          >
            {c.passed === true ? "Pass" : c.passed === false ? (c.code ?? "Fail") : "Not evaluated"}
          </span>
        </div>
      ))}
    </div>
  );
}

type SafetyCheckRow = {
  key: string;
  label: string;
  passed: boolean | null;
  code: string | null;
};

function SeatCard({ seat, index }: { seat: SeatView; index: number }) {
  const label =
    seat.state === "evaluated"
      ? (seat.direction ?? "—").toUpperCase()
      : seat.state === "unavailable"
        ? "Unavailable"
        : "Not asked";
  const tone =
    seat.state === "evaluated"
      ? "text-white/85"
      : seat.state === "unavailable"
        ? "text-amber-300"
        : "text-white/35";
  return (
    <div className="rounded-lg border border-white/10 bg-black/50 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[9.5px] uppercase tracking-[0.16em] text-white/40">
          {aiReviewLabel(index)}
        </p>
        <span className={cn("text-[10.5px] font-semibold uppercase tracking-wider", tone)}>
          {label}
        </span>
      </div>
      {seat.state === "evaluated" && (
        <p className="mt-1 text-[10.5px] text-white/45">
          confidence {seat.confidence === null ? "—" : seat.confidence.toFixed(2)}
          {seat.latencyMs !== null ? ` · ${seat.latencyMs}ms` : ""}
          {seat.agreesWithDecision ? " · agrees" : " · differs"}
        </p>
      )}
      {seat.summary && (
        <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-white/55">{seat.summary}</p>
      )}
      {seat.staleEvidence && (
        <p className="mt-1 text-[10px] text-amber-300/70">Recorded against different evidence.</p>
      )}
    </div>
  );
}

export function LiveDecisionFlowPanel() {
  const [symbol, setSymbol] = useState<string>(FLOW_SYMBOLS[0]);
  const { user } = useAuth();
  const flow = useLiveDecisionFlow(symbol);

  // Owner-only control. The server re-checks the role; this only hides the UI.
  const { data: isAdmin } = useQuery({
    queryKey: ["role", "admin", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase.rpc("has_role", { _user_id: user!.id, _role: "admin" });
      return data === true;
    },
  });

  const dto = flow.data;
  const decision = dto?.decision ?? null;
  const age = decision ? decisionAgeMs(decision, Date.now()) : null;

  return (
    <CommandPanel
      title="Live decision flow"
      subtitle="Market → Decision → Safety → ApeX. Read-only proof; no stage is inferred."
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          {FLOW_SYMBOLS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSymbol(s)}
              className={cn(
                "rounded-md border px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider transition",
                s === symbol
                  ? "border-[#4EA8FF]/60 bg-[#4EA8FF]/15 text-[#9ecbff]"
                  : "border-white/10 text-white/50 hover:text-white/80",
              )}
            >
              {s.replace("-USDT", "")}
            </button>
          ))}
        </div>
      }
    >
      {flow.isLoading ? (
        <p className="py-6 text-center text-[12px] text-white/50">Loading decision flow…</p>
      ) : flow.error ? (
        <p className="py-6 text-center text-[12px] text-red-400">{flow.error}</p>
      ) : !dto ? (
        <p className="py-6 text-center text-[12px] text-white/50">No projection available.</p>
      ) : (
        <div className="space-y-4">
          {/* Headline: symbol, direction, exact reason, execution outcome. */}
          <div className="rounded-lg border border-white/10 bg-black/50 px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-display text-[15px] tracking-wide text-white/90">{symbol}</span>
              <span
                className={cn(
                  "rounded border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider",
                  DIRECTION_STYLE[decision?.direction ?? "wait"],
                )}
              >
                {decision?.direction?.toUpperCase() ?? "NONE RECORDED"}
              </span>
              {decision && (
                <span className="text-[10.5px] uppercase tracking-wider text-white/35">
                  {decision.strategy}
                </span>
              )}
            </div>
            <p className="mt-1.5 text-[12px] leading-relaxed text-white/70">
              {decision ? reasonProse(decision.reasonCode, decision.reason) : dto.headline}
            </p>
            <p className="mt-1 text-[11px] text-white/45">{dto.headline}</p>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "Worker", value: workerStateLabel(dto.worker.state) },
              { label: "Last candle", value: formatAge(age) },
              { label: "Reason code", value: decision?.reasonCode ?? "—" },
              { label: "Intent state", value: decision?.executionState ?? "—" },
            ].map((m) => (
              <div key={m.label} className="rounded-lg border border-white/10 bg-black/50 px-2.5 py-2">
                <p className="text-[9.5px] uppercase tracking-[0.16em] text-white/40">{m.label}</p>
                <p className="mt-0.5 truncate text-[12.5px] font-semibold text-white/85">{m.value}</p>
              </div>
            ))}
          </div>

          <ol className="mt-1">
            {dto.steps.map((step, i) => (
              <StepRow key={step.key} step={step} last={i === dto.steps.length - 1} />
            ))}
          </ol>

          {/* Terminal outcome — the one persisted end-state for this
              evaluation. Never inferred: blank means nothing was written. */}
          <div className="rounded-lg border border-white/10 bg-black/50 px-3 py-2.5">
            <p className="text-[9.5px] uppercase tracking-[0.16em] text-white/40">
              Terminal outcome (persisted)
            </p>
            {decision?.terminalOutcome ? (
              <>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "rounded border px-2 py-0.5 text-[11px] font-semibold tracking-wide",
                      decision.terminalOutcome === "TRADE_CANDIDATE"
                        ? "border-[#14F195]/50 bg-[#14F195]/10 text-[#14F195]"
                        : decision.terminalOutcome === "PIPELINE_ERROR"
                          ? "border-red-500/50 bg-red-500/10 text-red-400"
                          : "border-white/20 bg-white/5 text-white/70",
                    )}
                  >
                    {decision.terminalOutcome}
                  </span>
                  <span className="text-[11.5px] text-white/70">{decision.terminalReason ?? "—"}</span>
                </div>
                <div className="mt-1.5 grid grid-cols-1 gap-1 text-[10.5px] text-white/45 sm:grid-cols-2">
                  <span>Trace {decision.traceId ?? "—"}</span>
                  <span>
                    Intent{" "}
                    {decision.simulatedIntent
                      ? `${decision.simulatedIntent.status ?? "—"} (simulated, not submitted)`
                      : "not created"}
                  </span>
                </div>
              </>
            ) : (
              <p className="mt-1 text-[11.5px] text-white/45">
                Not written yet — the pipeline sweep has not finalized this evaluation.
              </p>
            )}
          </div>


          {decision && (decision.entryZone || decision.invalidation !== null || decision.takeProfits.length > 0) && (
            <div className="space-y-1">
              <p className="text-[9.5px] uppercase tracking-[0.16em] text-white/40">Levels</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5">
                  <p className="text-[9.5px] uppercase tracking-wider text-white/35">Entry</p>
                  <p className="text-[11.5px] text-white/75">
                    {decision.entryZone
                      ? `${decision.entryZone.low} – ${decision.entryZone.high}`
                      : "—"}
                  </p>
                </div>
                <div className="rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5">
                  <p className="text-[9.5px] uppercase tracking-wider text-white/35">Invalidation</p>
                  <p className="text-[11.5px] text-white/75">{decision.invalidation ?? "—"}</p>
                </div>
                <div className="rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5">
                  <p className="text-[9.5px] uppercase tracking-wider text-white/35">Take profits</p>
                  <p className="text-[11.5px] text-white/75">
                    {decision.takeProfits.length > 0 ? decision.takeProfits.join(" · ") : "—"}
                  </p>
                </div>
              </div>
            </div>
          )}

          {decision?.safety && <SafetyGrid checks={decision.safety.checks} />}

          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <p className="text-[9.5px] uppercase tracking-[0.16em] text-white/40">
                AI — advisory only, never gates execution
              </p>
              {flow.committeePending && <Loader2 className="h-3 w-3 animate-spin text-white/30" />}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {dto.seats.map((seat, i) => (
                <SeatCard key={seat.role} seat={seat} index={i} />
              ))}
            </div>
          </div>

          {isAdmin && (
            <div className="rounded-lg border border-white/10 bg-black/50 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[11.5px] font-semibold text-white/80">AI connectivity check</p>
                  <p className="text-[11px] text-white/45">
                    Diagnostic only: one synthetic TEST snapshot through all three seats. It is not evidence that
                    any real candle was evaluated, and it cannot create a decision or place an order.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={flow.check.isPending}
                  onClick={() => flow.check.mutate()}
                >
                  {flow.check.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  Run check
                </Button>
              </div>

              {flow.check.error instanceof Error && (
                <p className="mt-2 text-[11px] text-red-400">{flow.check.error.message}</p>
              )}

              {flow.check.data && (
                <div className="mt-3 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wider text-amber-300">
                      Test · non-trading
                    </span>
                    <span className="text-[10.5px] text-white/40">
                      {flow.check.data.testCandidateId} · {flow.check.data.totalLatencyMs}ms
                    </span>
                  </div>
                  {flow.check.data.outcomes.map((o, oi) => (
                    <div
                      key={o.role}
                      className="flex items-center justify-between gap-2 rounded-md border border-white/10 px-2.5 py-1.5"
                    >
                      <span className="text-[11px] uppercase tracking-wider text-white/65">{aiReviewLabel(oi)}</span>
                      <span
                        className={cn(
                          "flex items-center gap-1 text-[11px] font-semibold",
                          o.available ? "text-[#14F195]" : "text-red-400",
                        )}
                      >
                        {o.available ? (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        ) : (
                          <MinusCircle className="h-3.5 w-3.5" />
                        )}
                        {o.available ? `${o.latencyMs}ms` : (o.reason ?? "unavailable")}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <p className="text-[10px] text-white/30">
            Generated {new Date(dto.generatedAt).toLocaleTimeString()}
            {decision ? ` · decision ${decision.decisionId}` : ""}
          </p>
        </div>
      )}
    </CommandPanel>
  );
}
