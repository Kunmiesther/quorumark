import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Activity, Globe2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { SurfaceCard } from "@/components/phantom/SurfaceCard";
import { SectionHeading, StatusDot } from "@/components/exchanges/trust/primitives";
import { supabase } from "@/integrations/supabase/client";

type Jurisdiction = "US" | "JM" | "MX";
type Result = {
  ok: boolean;
  checked_at: string;
  scenario: { jurisdiction: Jurisdiction; simulated_only: boolean };
  venues: {
    aster: {
      api_version: string;
      public_data_reachable: boolean;
      latency_ms: number | null;
      market_count: number;
      target_symbols: Record<string, boolean>;
      execution: string;
    };
    synfutures: {
      reachable: boolean;
      latency_ms: number;
      chain_id: number | null;
      network: string;
      sdk: string;
      market_discovery: string;
      execution: string;
    };
  };
};

const REGIONS: { id: Jurisdiction; label: string }[] = [
  { id: "US", label: "United States" },
  { id: "JM", label: "Jamaica" },
  { id: "MX", label: "Mexico" },
];

export function VenueReadinessPanel() {
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction>("US");
  const probe = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("venue-readiness", {
        body: { jurisdiction },
      });
      if (error || !data?.ok) throw new Error("Venue probe failed.");
      return data as Result;
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Venue probe failed."),
  });
  const result = probe.data;

  return (
    <SurfaceCard>
      <SectionHeading
        title="International venue lab"
        subtitle="Owner-only public-data checks for venue selection. No orders are sent."
        actions={<Globe2 className="h-4 w-4 text-primary" />}
      />

      <div className="grid grid-cols-3 gap-2">
        {REGIONS.map((region) => (
          <button
            key={region.id}
            type="button"
            onClick={() => setJurisdiction(region.id)}
            className={`rounded-xl border px-2 py-2 text-[11px] font-semibold transition ${
              jurisdiction === region.id
                ? "border-primary/40 bg-primary/10 text-white"
                : "border-white/10 bg-white/[0.03] text-white/55"
            }`}
          >
            {region.label}
          </button>
        ))}
      </div>

      <p className="mt-3 text-[10.5px] leading-relaxed text-white/45">
        Region selection is a planning scenario. It does not change server routing, prove venue
        eligibility, or unlock live execution.
      </p>

      <button
        type="button"
        disabled={probe.isPending}
        onClick={() => probe.mutate()}
        className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-primary text-[12px] font-semibold text-primary-foreground disabled:opacity-60"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${probe.isPending ? "animate-spin" : ""}`} />
        {probe.isPending ? "Checking venues…" : "Run public-data checks"}
      </button>

      {result && (
        <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
          <VenueResult
            name="Aster"
            ready={result.venues.aster.public_data_reachable}
            detail={`V3 · ${result.venues.aster.market_count} markets · ${result.venues.aster.latency_ms ?? "—"} ms`}
            note="Public API check only. See the Aster connection for verified account and execution status."
          />
          <VenueResult
            name="SynFutures"
            ready={result.venues.synfutures.reachable && result.venues.synfutures.chain_id === 8453}
            detail={`Base · chain ${result.venues.synfutures.chain_id ?? "—"} · ${result.venues.synfutures.latency_ms} ms`}
            note="Network check only. Use SynFutures setup below to inspect the installed SDK and contracts."
          />
        </div>
      )}
    </SurfaceCard>
  );
}

function VenueResult({
  name,
  ready,
  detail,
  note,
}: {
  name: string;
  ready: boolean;
  detail: string;
  note: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-3">
      <div className="flex items-center gap-2">
        <StatusDot tone={ready ? "ok" : "down"} />
        <p className="text-[12px] font-semibold text-white">{name}</p>
        <Activity className="ml-auto h-3.5 w-3.5 text-white/35" />
      </div>
      <p className="mt-2 text-[11px] text-white/65">{detail}</p>
      <p className="mt-1 text-[10px] leading-relaxed text-white/40">{note}</p>
    </div>
  );
}
