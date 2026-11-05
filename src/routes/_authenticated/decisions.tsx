/**
 * AI DECISION ROOM — real stored evaluations only.
 *
 * Every value on this page is read from a persisted row: the deterministic
 * signal, each model's recorded answer (or its recorded reason for being
 * unavailable), the consolidated orchestration verdict, the one consolidated
 * risk check and the terminal outcome. There is no "thinking" animation and
 * no placeholder decision — when nothing has been recorded, the page says so.
 */
import { aiReviewLabel } from "@/lib/ai/committee/roles";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listDecisionRoom } from "@/lib/decision/decisionFlow.functions";
import type { DecisionRoomEntry } from "@/lib/decision/decisionFlow";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  listPaperOrchestrations,
  type PaperOrchestrationEntry,
} from "@/lib/paper/orchestration.functions";

export const Route = createFileRoute("/_authenticated/decisions")({
  head: () => ({
    meta: [
      { title: "Decisions · Quorumark" },
      {
        name: "description",
        content:
          "Every recorded Quorumark evaluation, agent vote, policy check, and outcome.",
      },
      { property: "og:title", content: "Decisions · Quorumark" },
      {
        property: "og:description",
        content:
          "Evidence backed view of Quorumark's agent votes and policy decisions.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: DecisionRoom,
});

function directionTone(direction: string | null): string {
  if (direction === "long") return "text-[#14F195]";
  if (direction === "short") return "text-[#FF5C7A]";
  return "text-muted-foreground";
}

function EntryCard({ entry }: { entry: DecisionRoomEntry }) {
  const asked = entry.opinions.length;
  const answered = entry.opinions.filter((o) => o.status === "evaluated").length;
  const degraded = asked > 0 && answered < asked;

  return (
    <Card className="p-4 space-y-3 bg-card/60">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex items-center gap-2">
          <span className="font-semibold tracking-wide">{entry.symbol}</span>
          <span className="text-xs text-muted-foreground">
            {entry.timeframe} · {entry.strategy}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          {new Date(entry.candleCloseAt).toLocaleString()}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline" className={directionTone(entry.deterministicDirection)}>
          Strategy: {entry.deterministicDirection.toUpperCase()}
        </Badge>
        {entry.terminalOutcome ? (
          <Badge variant="secondary">{entry.terminalOutcome}</Badge>
        ) : (
          <Badge variant="outline">no terminal outcome recorded</Badge>
        )}
        {entry.risk ? (
          <Badge variant="outline" className={entry.risk.passed ? "text-[#14F195]" : "text-[#FFB020]"}>
            Risk: {entry.risk.passed ? "passed" : entry.risk.code || "blocked"}
          </Badge>
        ) : null}
        {degraded ? (
          <Badge variant="outline" className="text-[#FFB020]">
            degraded — {answered}/{asked} seats answered
          </Badge>
        ) : null}
      </div>

      {entry.deterministicReason ? (
        <p className="text-xs text-muted-foreground">{entry.deterministicReason}</p>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-3">
        {asked === 0 ? (
          <p className="text-xs text-muted-foreground sm:col-span-3">
            The advisory seats have not been asked about this candle yet.
          </p>
        ) : (
          entry.opinions.map((o, oi) => (
            <div key={o.role} className="rounded-md border border-border/60 p-2 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">{aiReviewLabel(oi)}</span>
                
              </div>
              {o.status === "evaluated" ? (
                <>
                  <p className={`text-xs font-semibold ${directionTone(o.direction)}`}>
                    {(o.direction ?? "wait").toUpperCase()}
                    {o.confidence == null ? "" : ` · ${Math.round(o.confidence * 100)}%`}
                  </p>
                  <p className="text-[11px] text-muted-foreground line-clamp-4">{o.summary}</p>
                </>
              ) : (
                <p className="text-[11px] text-[#FFB020]">
                  unavailable — {o.unavailableReason ?? "no reason recorded"}
                </p>
              )}
            </div>
          ))
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        {entry.orchestration ? (
          <span>
            Consolidated: <span className="text-foreground">{entry.orchestration.verdict}</span>
            {entry.orchestration.consensusDirection
              ? ` → ${entry.orchestration.consensusDirection}`
              : ""}
            {entry.orchestration.riskDissent ? " · risk seat dissents" : ""}
          </span>
        ) : (
          <span>Consolidated record not written for this candle.</span>
        )}
        {entry.traceId ? <span>trace {entry.traceId.slice(0, 8)}</span> : null}
      </div>
    </Card>
  );
}

const PARTICIPATION_LABEL: Record<string, string> = {
  full_3_of_3: "3/3 models",
  degraded_2_of_3: "degraded 2/3",
  degraded_1_of_3: "degraded 1/3",
  ai_unavailable: "AI unavailable",
};

function PaperTraceCard({ entry }: { entry: PaperOrchestrationEntry }) {
  return (
    <Card className="p-4 space-y-3 bg-card/60">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold tracking-wide">{entry.symbol}</span>
          <span className={`text-xs font-semibold ${directionTone(entry.direction)}`}>
            {entry.direction.toUpperCase()}
          </span>
          <span className="text-xs text-muted-foreground">{entry.strategy}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {new Date(entry.createdAt).toLocaleString()}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline" className={entry.degraded ? "text-[#FFB020]" : "text-[#14F195]"}>
          {PARTICIPATION_LABEL[entry.participation] ?? entry.participation}
        </Badge>
        <Badge variant="secondary">ONYX Synthesis: {entry.onyxDecision.toUpperCase()}</Badge>
        <Badge variant="outline" className={entry.riskPassed ? "text-[#14F195]" : "text-[#FFB020]"}>
          Risk: {entry.riskPassed ? "passed" : entry.riskCode || "not evaluated"}
        </Badge>
        <Badge variant="secondary">{entry.terminalOutcome}</Badge>
        {entry.paperTradeId ? (
          <Badge variant="outline">trade {entry.paperTradeId.slice(0, 8)}</Badge>
        ) : entry.paperPositionId ? (
          <Badge variant="outline">position {entry.paperPositionId.slice(0, 8)}</Badge>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">{entry.onyxRationale}</p>

      <div className="grid gap-2 sm:grid-cols-3">
        {entry.opinions.length === 0 ? (
          <p className="text-xs text-muted-foreground sm:col-span-3">No seat rows recorded.</p>
        ) : (
          entry.opinions.map((o, oi) => (
            <div key={o.role} className="rounded-md border border-border/60 p-2 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">{aiReviewLabel(oi)}</span>
                
              </div>
              {o.status === "evaluated" ? (
                <>
                  <p className={`text-xs font-semibold ${directionTone(o.direction)}`}>
                    {(o.direction ?? "wait").toUpperCase()}
                    {o.confidence == null ? "" : ` · ${Math.round(o.confidence * 100)}%`}
                  </p>
                  <p className="text-[11px] text-muted-foreground line-clamp-4">{o.summary}</p>
                </>
              ) : (
                <p className="text-[11px] text-[#FFB020]">
                  unavailable — {o.unavailableReason ?? "no reason recorded"}
                </p>
              )}
            </div>
          ))
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">trace {entry.traceId.slice(0, 8)}</p>
    </Card>
  );
}

function PaperOrchestrationSection() {
  const fn = useServerFn(listPaperOrchestrations);
  const { data, isLoading, error } = useQuery({
    queryKey: ["paper-orchestrations"],
    refetchInterval: 30_000,
    queryFn: () => fn({ data: { limit: 20 } }),
  });
  const m = data?.metrics;

  return (
    <section className="space-y-3">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold tracking-wide">Paper trades — mandatory AI orchestration</h2>
        <p className="text-sm text-muted-foreground">
          Every paper candidate is fanned out to all three advisory seats before ONYX Synthesis resolves them and the
          single consolidated risk check runs. No paper position can be opened without this trace.
        </p>
      </header>

      {m ? (
        <Card className="p-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div><p className="text-muted-foreground">3/3 participation</p><p className="text-base font-semibold text-[#14F195]">{m.full3of3}</p></div>
          <div><p className="text-muted-foreground">degraded 2/3</p><p className="text-base font-semibold">{m.degraded2of3}</p></div>
          <div><p className="text-muted-foreground">degraded 1/3</p><p className="text-base font-semibold">{m.degraded1of3}</p></div>
          <div><p className="text-muted-foreground">AI unavailable</p><p className="text-base font-semibold">{m.aiUnavailable}</p></div>
          <div><p className="text-muted-foreground">trade candidates</p><p className="text-base font-semibold">{m.tradeCandidates}</p></div>
          <div><p className="text-muted-foreground">wait decisions</p><p className="text-base font-semibold">{m.waitDecisions}</p></div>
          <div><p className="text-muted-foreground">orchestrations</p><p className="text-base font-semibold">{m.orchestrations}</p></div>
          <div>
            <p className="text-muted-foreground">missing-trace violations</p>
            <p className={`text-base font-semibold ${m.missingTraceViolations === 0 ? "text-[#14F195]" : "text-[#FF5C7A]"}`}>
              {m.missingTraceViolations}
            </p>
          </div>
        </Card>
      ) : null}

      {isLoading ? (
        <Card className="p-4 text-sm text-muted-foreground">Loading paper orchestration traces…</Card>
      ) : error ? (
        <Card className="p-4 text-sm text-[#FF5C7A]">
          Could not load paper traces: {error instanceof Error ? error.message : "unknown error"}
        </Card>
      ) : (data?.entries ?? []).length === 0 ? (
        <Card className="p-4 text-sm text-muted-foreground">
          No paper orchestration traces recorded yet.
        </Card>
      ) : (
        <div className="space-y-3">
          {(data?.entries ?? []).map((e) => <PaperTraceCard key={e.traceId} entry={e} />)}
        </div>
      )}
    </section>
  );
}

function DecisionRoom() {
  const fn = useServerFn(listDecisionRoom);
  const { data, isLoading, error } = useQuery({
    queryKey: ["decision-room"],
    refetchInterval: 30_000,
    queryFn: () => fn({ data: { limit: 15 } }),
  });

  return (
    <div className="mx-auto w-full max-w-5xl p-4 space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-wide">AI Decision Room</h1>
        <p className="text-sm text-muted-foreground">
          Deterministic strategy first; three advisory models second. Models never approve,
          size, or place a trade — their opinions are recorded beside the decision.
        </p>
      </header>

      {isLoading ? (
        <Card className="p-4 text-sm text-muted-foreground">Loading recorded evaluations…</Card>
      ) : error ? (
        <Card className="p-4 text-sm text-[#FF5C7A]">
          Could not load evaluations: {error instanceof Error ? error.message : "unknown error"}
        </Card>
      ) : (data?.entries ?? []).length === 0 ? (
        <Card className="p-4 text-sm text-muted-foreground">
          No evaluations recorded yet. The system is waiting for a completed candle with a
          confirmed setup — a WAIT is a valid, recorded result, not a failure.
        </Card>
      ) : (
        <div className="space-y-3">
          {(data?.entries ?? []).map((entry) => (
            <EntryCard key={entry.decisionId} entry={entry} />
          ))}
        </div>
      )}

      <PaperOrchestrationSection />
    </div>
  );
}
