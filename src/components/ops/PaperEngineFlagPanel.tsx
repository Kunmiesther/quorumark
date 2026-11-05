import { useQuery } from "@tanstack/react-query";
import { getPaperEngineFlag } from "@/lib/paper/killSwitch.functions";

/**
 * Shows the current ON/OFF state of the global paper kill switch.
 * Toggle it by setting the server env var `PAPER_ENGINE_ENABLED`
 * ("0"/"false"/"off" = OFF, unset or "1"/"true"/"on" = ON).
 */
export function PaperEngineFlagPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ["paper-engine-flag"],
    queryFn: () => getPaperEngineFlag(),
    refetchInterval: 30_000,
  });

  const enabled = data?.enabled ?? null;
  const tone =
    enabled === null
      ? "border-border bg-muted/20 text-muted-foreground"
      : enabled
        ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
        : "border-red-400/30 bg-red-400/10 text-red-300";

  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">
            Paper engine kill switch
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Env var <code>PAPER_ENGINE_ENABLED</code> — set to{" "}
            <code>false</code> to stop every paper tick immediately. Historical
            paper data is preserved.
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold ${tone}`}
        >
          {isLoading ? "…" : enabled ? "ON" : "OFF"}
        </span>
      </div>
    </section>
  );
}
