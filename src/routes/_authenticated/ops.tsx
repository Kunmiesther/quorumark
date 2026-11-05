import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery, queryOptions } from "@tanstack/react-query";
import { getOpsHealth } from "@/lib/ops/ops.functions";
import { OpsPanel } from "@/components/ops/OpsPanel";
import { VenueRejectionsPanel } from "@/components/ops/VenueRejectionsPanel";
import { PaperEngineFlagPanel } from "@/components/ops/PaperEngineFlagPanel";
import { LiveAdvisoryPanel } from "@/components/ops/LiveAdvisoryPanel";
import { UniverseStatusCard } from "@/components/universe/UniverseStatusCard";


const opsHealthQuery = queryOptions({
  queryKey: ["ops-health"],
  queryFn: () => getOpsHealth(),
  refetchInterval: 15_000,
});

export const Route = createFileRoute("/_authenticated/ops")({
  loader: ({ context }) => context.queryClient.ensureQueryData(opsHealthQuery),
  component: OpsRoute,
  head: () => ({
    meta: [
      { title: "Operations — Turtle Bot Control Plane" },
      {
        name: "description",
        content:
          "Server-side reliability panel: component health, freshness, latency percentiles, decision ledger, and correlation log. Paper mode only.",
      },
      { property: "og:title", content: "Operations — Turtle Bot Control Plane" },
      { property: "og:description", content: "Reliability & telemetry for the paper trading control plane." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function OpsRoute() {
  const { data } = useSuspenseQuery(opsHealthQuery);
  return (
    <div className="space-y-4">
      <PaperEngineFlagPanel />
      <LiveAdvisoryPanel />
      <UniverseStatusCard />
      <OpsPanel data={data} />
      <VenueRejectionsPanel />
    </div>
  );
}




