import { createFileRoute } from "@tanstack/react-router";
import { AtmosphereShell } from "@/components/command/AtmosphereShell";
import { CommandPanel } from "@/components/command/CommandPanel";
import { ScoutHeader } from "@/components/scout/ScoutHeader";
import { BlockchainDiscoveryPanel } from "@/components/scout/BlockchainDiscoveryPanel";
import { ScoutSymbolCard } from "@/components/scout/ScoutSymbolCard";
import { ScoutDefensePanel } from "@/components/scout/ScoutDefensePanel";
import { LiveDecisionFlowPanel } from "@/components/scout/LiveDecisionFlowPanel";
import { CandidateFeedCard } from "@/components/candidate/CandidateFeedCard";
import { CandidateOnyxExplanation } from "@/components/candidate/CandidateOnyxExplanation";
import { CandidateLifecycleTimeline } from "@/components/trade/CandidateLifecycleTimeline";
import { CommitteePanel } from "@/components/trade/CommitteePanel";
import { CommitteeCalibrationPanel } from "@/components/trade/CommitteeCalibrationPanel";
import { LiveActivityRail } from "@/components/trade/LiveActivityRail";

import { useScoutIntelligence } from "@/hooks/useScoutIntelligence";
import { useScoutActivation } from "@/hooks/useScoutActivation";
import { useCandidateFeed } from "@/hooks/useCandidateFeed";
import { useCandidateLifecycle } from "@/hooks/useCandidateLifecycle";
import { useIntelligenceFeed } from "@/hooks/useIntelligenceFeed";

import { Link } from "@tanstack/react-router";
import { AlertTriangle, Radar } from "lucide-react";

type ScoutSearch = { candidate?: string };

export const Route = createFileRoute("/_authenticated/scout")({
  component: ScoutPage,
  validateSearch: (raw: Record<string, unknown>): ScoutSearch => {
    const c = typeof raw.candidate === "string" ? raw.candidate.slice(0, 128) : undefined;
    return { candidate: c || undefined };
  },
  head: () => ({
    meta: [
      { title: "Scout — Multi-Timeframe Recon" },
      {
        name: "description",
        content:
          "Read-only multi-timeframe market recon. Monthly through 5m evidence, deterministic consensus, no trade execution.",
      },
    ],
  }),
});

function ScoutPage() {
  const { active, setActive, saving, error: activationError } = useScoutActivation();
  const { candidate: selectedId } = Route.useSearch();
  const query = useScoutIntelligence();
  const { data, isFetching, isError, error, refetch } = query;
  const feed = useCandidateFeed();
  const lifecycle = useCandidateLifecycle(selectedId ? { candidateId: selectedId } : null);
  const intelligence = useIntelligenceFeed(null);

  return (
    <AtmosphereShell
      className="w-full max-w-[1600px]"
      showHeader={false}
      accent="#22D3EE"
      eyebrow="Recon Layer"
      title="Scout"
      subtitle="Multi-timeframe intelligence — monthly through 5m. Monitoring only, never executes."
    >
      <ScoutHeader data={data} isScanning={isFetching} onRefresh={() => refetch()} />

      <BlockchainDiscoveryPanel />

      <LiveDecisionFlowPanel />

      <CommitteePanel
        symbol={intelligence.latest?.symbol ?? "BTC-USDT"}
        evaluation={intelligence.latest}
        isLoading={intelligence.isLoading}
      />

      <LiveActivityRail
        evaluations={intelligence.recent}
        isLoading={intelligence.isLoading}
        nowMs={intelligence.feed?.serverTimeMs ?? Date.now()}
      />

      <CommitteeCalibrationPanel metrics={intelligence.metrics} />

      <CommandPanel
        title="Candidates (historical)"
        subtitle="Candidate records from before the decision ledger. Preserved as history — the live worker now records one decision per completed candle, shown above."
      >
        {feed.isLoading ? (
          <p className="py-6 text-center text-[12px] text-white/50">Loading candidates…</p>
        ) : !feed.data || feed.data.length === 0 ? (
          <p
            className="py-6 text-center text-[12px] text-white/50"
            data-testid="candidate-feed-empty"
          >
            No historical candidates recorded.
          </p>
        ) : (
          <div
            className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))]"
            data-testid="candidate-feed"
          >
            {feed.data.map((dto) => (
              <CandidateFeedCard
                key={dto.candidate.candidateId}
                dto={dto}
                to="/scout"
                selected={dto.candidate.candidateId === selectedId}
              />
            ))}
          </div>
        )}
      </CommandPanel>

      {selectedId ? (
        <div key={lifecycle.selectionKey} className="space-y-3">
          <CandidateLifecycleTimeline
            lifecycle={lifecycle.lifecycle}
            freshness={lifecycle.freshness}
            isLoading={lifecycle.isLoading}
          />
          <CandidateOnyxExplanation
            lifecycle={lifecycle.lifecycle}
            fallbackEvaluation={intelligence.latest}
            isLoading={lifecycle.isLoading || lifecycle.evaluating}
          />

          <Link
            to="/trade"
            search={{ candidate: selectedId }}
            className="inline-block rounded-lg border border-white/15 px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-wider text-white/70 hover:border-white/30"
            data-testid="candidate-open-desk"
          >
            Open on desk
          </Link>
        </div>
      ) : null}

      {!active ? (
        <CommandPanel>
          <div className="flex flex-wrap items-center gap-3 py-4 text-[12px] text-white/55">
            <Radar className="h-4 w-4 text-white/40" />
            <span className="min-w-0 flex-1">
              Scout is dormant. Start it to scan BTC, ETH, SOL, and XRP now.
            </span>
            <button
              type="button"
              disabled={saving}
              onClick={() => setActive(true)}
              className="tb-neu-raised rounded-xl px-4 py-2 text-[11px] font-semibold text-cyan-200 disabled:opacity-50"
            >
              {saving ? "Starting…" : "Start Scout"}
            </button>
          </div>
          {activationError ? (
            <p className="pb-3 text-[11px] text-rose-300">{activationError}</p>
          ) : null}
        </CommandPanel>
      ) : isError ? (
        <CommandPanel tone="danger">
          <div className="flex items-start gap-2 text-[12px] text-[hsl(var(--state-danger))]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <div className="font-semibold">Scan failed</div>
              <div className="text-white/60">
                {error instanceof Error ? error.message : "Unknown error"}
              </div>
            </div>
          </div>
        </CommandPanel>
      ) : !data || data.symbols.length === 0 ? (
        <CommandPanel>
          <p className="py-6 text-center text-[12px] text-white/50">
            {isFetching ? "Pulling multi-timeframe candles…" : "No symbols in scan universe."}
          </p>
        </CommandPanel>
      ) : (
        <>
          <CommandPanel
            title="Symbol intelligence"
            subtitle="Per-symbol MTF evidence matrix — consensus bias, confidence, conflict."
          >
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr))]">
              {data.symbols.map((s) => (
                <ScoutSymbolCard key={s.symbol} report={s} />
              ))}
            </div>
          </CommandPanel>

          <ScoutDefensePanel />
        </>
      )}

      <p className="pt-2 text-center text-[10.5px] uppercase tracking-wider text-white/30">
        Monitoring only · No trade execution · Read-only intelligence
      </p>
    </AtmosphereShell>
  );
}
