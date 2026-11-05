/**
 * AGENTIC TRADING COMMAND CENTER — stored production/paper data only.
 *
 * Every number on this page comes from a persisted row: orchestration traces,
 * recorded model opinions, ONYX synthesis, the one consolidated risk decision,
 * position-management events and closed-trade reviews. There is no simulated
 * deliberation, no placeholder agent activity and no animated "thinking" —
 * when nothing has been recorded, the page says so.
 */
import { aiReviewLabel } from "@/lib/ai/committee/roles";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getAgenticOverview } from "@/lib/agentic/agentic.functions";

export const Route = createFileRoute("/_authenticated/agentic")({
  head: () => ({
    meta: [
      { title: "Agent Council · Quorumark" },
      {
        name: "description",
        content:
          "Live agentic pipeline: Scout surveillance, deterministic strategies, three advisory seats, ONYX Synthesis, one consolidated risk check and paper execution.",
      },
      { property: "og:title", content: "Agent Council · Quorumark" },
      {
        property: "og:description",
        content:
          "Evidence backed view of every Quorumark agent and recorded decision.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AgenticCommandCenter,
});

const STATE_TONE: Record<string, string> = {
  healthy: "text-[#14F195]",
  degraded: "text-[#FFB347]",
  unavailable: "text-[#FF5C7A]",
};

const ACTION_TONE: Record<string, string> = {
  HOLD: "text-muted-foreground",
  BANK_PROFIT: "text-[#14F195]",
  MOVE_TO_APPROVED_BREAKEVEN: "text-[#4EA8FF]",
  FILL_APPROVED_RUNG: "text-[#9945FF]",
  HEDGE: "text-[#FFB347]",
  EXIT: "text-[#FF5C7A]",
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">{title}</h2>
        {subtitle ? <p className="text-xs text-muted-foreground/80 mt-1">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  );
}

function AgenticCommandCenter() {
  const fetchOverview = useServerFn(getAgenticOverview);
  const { data, isLoading, error } = useQuery({
    queryKey: ["agentic-overview"],
    queryFn: () => fetchOverview(),
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading recorded agent activity…</div>;
  }
  if (error || !data) {
    return <div className="p-6 text-sm text-[#FF5C7A]">Could not load agent records.</div>;
  }

  const { pipeline, health, managementEvents, performance, promotion, promotionMetrics, proposals, integrity } = data;

  return (
    <main className="p-4 md:p-6 space-y-8 max-w-6xl mx-auto">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Agentic Command Center</h1>
        <p className="text-xs text-muted-foreground">
          Paper autonomy is active. Live agentic execution is disabled and owner-only. Every figure below is read from
          stored records.
        </p>
      </header>

      <Section
        title="Live pipeline"
        subtitle="Counts over the most recent recorded orchestration window — not a simulation."
      >
        <Card className="p-4 bg-card/60">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
            <Stat label="Scout" value={pipeline.scout ? "online" : "—"} />
            <Stat label="Candidates" value={String(pipeline.candidates)} />
            <Stat label="3-model advisory" value={String(pipeline.advisory)} />
            <Stat label="ONYX Synthesis enter" value={String(pipeline.onyxEnter)} />
            <Stat label="Risk passed" value={String(pipeline.riskPassed)} />
            <Stat label="Paper executed" value={String(pipeline.executed)} tone="text-[#14F195]" />
            <Stat label="Degraded" value={String(pipeline.degraded)} tone="text-[#FFB347]" />
          </div>
          <div className="flex flex-wrap gap-2 mt-4 text-[11px]">
            <Badge variant="outline">WAIT {pipeline.waits}</Badge>
            <Badge variant="outline">REJECTED {pipeline.rejected}</Badge>
            <Badge variant="outline">EXECUTED {pipeline.executed}</Badge>
          </div>
        </Card>
      </Section>

      <Section title="Agent health" subtitle="State, last recorded run and detail per specialized agent.">
        <div className="grid gap-3 md:grid-cols-2">
          {health.map((h) => (
            <Card key={h.agent} className="p-3 bg-card/60 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{h.agent}</div>
                <div className="text-[11px] text-muted-foreground truncate">{h.detail}</div>
              </div>
              <div className="text-right shrink-0">
                <div className={`text-xs font-semibold uppercase ${STATE_TONE[h.state]}`}>{h.state}</div>
                <div className="text-[10px] text-muted-foreground">
                  {h.lastRunAt ? new Date(h.lastRunAt).toLocaleString() : "no run recorded"}
                </div>
              </div>
            </Card>
          ))}
        </div>
      </Section>

      <Section
        title="Open-position timeline"
        subtitle="Every re-evaluation of an open paper position, with the three advisory seats, ONYX Synthesis's action and the risk outcome."
      >
        {managementEvents.length === 0 ? (
          <Card className="p-4 bg-card/60 text-xs text-muted-foreground">
            No position-management re-evaluations recorded yet.
          </Card>
        ) : (
          <div className="space-y-3">
            {managementEvents.map((e) => (
              <Card key={e.id} className="p-4 bg-card/60 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{e.symbol}</span>
                    <span className="text-xs text-muted-foreground">
                      {e.direction} · #{e.sequence} · {e.trigger}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[11px]">
                    <Badge variant="outline" className={e.degraded ? "text-[#FFB347]" : ""}>
                      {e.participation}
                    </Badge>
                    <Badge variant="outline" className={e.riskPassed ? "text-[#14F195]" : "text-[#FF5C7A]"}>
                      RISK {e.riskCode ?? "—"}
                    </Badge>
                    <span className={`font-semibold ${ACTION_TONE[e.action] ?? ""}`}>{e.action}</span>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{e.rationale}</p>
                <div className="grid gap-2 md:grid-cols-3">
                  {e.opinions.map((o, oi) => (
                    <div key={o.role} className="rounded-md border border-border/40 p-2">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-medium">{aiReviewLabel(oi)}</span>
                        <span className={o.status === "evaluated" ? "text-[#14F195]" : "text-[#FF5C7A]"}>
                          {o.status}
                        </span>
                      </div>
                      
                      <div className="text-[11px] mt-1">
                        {o.status === "evaluated"
                          ? `${o.direction ?? "—"} · ${o.confidence == null ? "—" : o.confidence.toFixed(2)} · ${o.latencyMs ?? "—"}ms`
                          : (o.unavailableReason ?? "unavailable")}
                      </div>
                      {o.summary ? (
                        <p className="text-[10px] text-muted-foreground mt-1 line-clamp-3">{o.summary}</p>
                      ) : null}
                    </div>
                  ))}
                </div>
                {!e.applied ? (
                  <div className="text-[10px] text-muted-foreground">
                    Advisory only — action not applied ({e.applyBlockedReason ?? "apply gate closed"}).
                  </div>
                ) : null}
                <div className="text-[10px] text-muted-foreground">
                  trace {e.traceId}
                  {e.parentTraceId ? ` · entry trace ${e.parentTraceId}` : " · entry trace unlinked (legacy position)"}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section title="Paper performance" subtitle="Attributed from closed paper trades only.">
        <Card className="p-4 bg-card/60 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
            <Stat label="Sample" value={String(performance.sampleSize)} />
            <Stat label="Win rate" value={`${performance.winRatePct}%`} />
            <Stat
              label="Net P&L"
              value={performance.netPnl.toFixed(2)}
              tone={performance.netPnl >= 0 ? "text-[#14F195]" : "text-[#FF5C7A]"}
            />
            <Stat label="Expectancy" value={performance.expectancy.toFixed(3)} />
            <Stat label="Profit factor" value={performance.profitFactor == null ? "—" : performance.profitFactor.toFixed(2)} />
            <Stat label="Max drawdown" value={`${performance.maxDrawdownPct.toFixed(1)}%`} />
            <Stat label="3/3 participation" value={`${performance.fullParticipation}/${performance.sampleSize}`} />
          </div>
          <div className="grid gap-4 md:grid-cols-3 text-xs">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">By strategy</div>
              {performance.byStrategy.length === 0 ? <div className="text-muted-foreground">—</div> : null}
              {performance.byStrategy.map((s) => (
                <div key={s.key} className="flex justify-between gap-2 tabular-nums">
                  <span className="truncate">{s.key}</span>
                  <span>{s.trades} · {s.winRatePct}% · {s.netPnl.toFixed(2)}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">By model</div>
              {performance.byModel.length === 0 ? <div className="text-muted-foreground">—</div> : null}
              {performance.byModel.map((m) => (
                <div key={m.key} className="flex justify-between gap-2 tabular-nums">
                  <span className="truncate">{m.key}</span>
                  <span>{m.correct}/{m.scored} · {m.accuracyPct}%</span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">By regime</div>
              {performance.byRegime.length === 0 ? <div className="text-muted-foreground">—</div> : null}
              {performance.byRegime.map((r) => (
                <div key={r.key} className="flex justify-between gap-2 tabular-nums">
                  <span className="truncate">{r.key}</span>
                  <span>{r.trades} · {r.winRatePct}% · {r.netPnl.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
          {performance.unattributedTrades > 0 ? (
            <div className="text-[10px] text-muted-foreground">
              {performance.unattributedTrades} closed trades predate the orchestration contract and are marked
              legacy/unattributed rather than back-filled.
            </div>
          ) : null}
        </Card>
      </Section>

      <Section
        title="Promotion gate — agentic live"
        subtitle="Implemented and DISABLED. Promotion requires explicit owner action and stays owner-only."
      >
        <Card className="p-4 bg-card/60 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline" className="text-[#FF5C7A]">
              AGENTIC LIVE {promotion.agenticLiveEnabled ? "ENABLED" : "DISABLED"}
            </Badge>
            <Badge variant="outline">{promotion.ownerApproved ? "owner approved" : "owner approval missing"}</Badge>
            {promotion.provisional ? (
              <Badge variant="outline" className="text-[#FFB347]">
                thresholds are unreviewed defaults — evaluation is provisional
              </Badge>
            ) : null}
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {promotion.checks.map((c) => (
              <div key={c.key} className="flex items-center justify-between gap-2 text-xs rounded-md border border-border/40 p-2">
                <span>{c.label}</span>
                <span className={`tabular-nums ${c.passed ? "text-[#14F195]" : "text-[#FF5C7A]"}`}>
                  {c.actual} <span className="text-muted-foreground">(need {c.required})</span>
                </span>
              </div>
            ))}
          </div>
          <div className="text-[11px] text-muted-foreground">
            Execution integrity {integrity.executionIntegrityPct}% · missing-trace violations{" "}
            <span className={integrity.missingTraceViolations === 0 ? "text-[#14F195]" : "text-[#FF5C7A]"}>
              {integrity.missingTraceViolations}
            </span>{" "}
            · risk-rule violations {promotionMetrics.riskRuleViolations}
            {integrity.legacyUntraced > 0 ? (
              <>
                {" "}· <span className="text-muted-foreground/70">
                  {integrity.legacyUntraced} legacy position
                  {integrity.legacyUntraced === 1 ? "" : "s"} predate the orchestration
                  contract and are excluded from integrity (never back-filled)
                </span>
              </>
            ) : null}
          </div>
        </Card>
      </Section>

      <Section
        title="Learning proposals"
        subtitle="The review agent may only propose. Nothing applies without explicit owner approval."
      >
        {proposals.length === 0 ? (
          <Card className="p-4 bg-card/60 text-xs text-muted-foreground">No rule proposals recorded.</Card>
        ) : (
          <div className="space-y-2">
            {proposals.map((p) => (
              <Card key={p.id} className="p-3 bg-card/60 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{p.title}</span>
                  <Badge variant="outline">{p.status}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{p.rationale}</p>
                <div className="text-[10px] text-muted-foreground">
                  {p.scope} · sample {p.sampleSize}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Section>
    </main>
  );
}
