import type { CAPABILITY_MATRIX } from "@/lib/ops/capabilityMatrix";
import type { SLO } from "@/lib/ops/slo";
import type { ComponentHealth, HealthState } from "@/lib/ops/watchdog";
import { MonitoringWalletsPanel } from "./MonitoringWalletsPanel";

interface OpsHealthResult {
  fleet_state: HealthState;
  server_ts: number;
  components: ComponentHealth[];
  recent_decisions: Array<{
    id: string;
    symbol: string;
    decision: string;
    reject_reason: string | null;
    decision_latency_ms: number | null;
    decision_at: string;
  }>;
  recent_events: Array<{
    id: string;
    correlation_id: string;
    stage: string;
    component: string;
    severity: string;
    message: string;
    server_ts: string;
  }>;
  capability_matrix: typeof CAPABILITY_MATRIX;
  slo_targets: typeof SLO;
  mainnet_enabled: boolean;
}

const STATE_COLOR: Record<HealthState, string> = {
  HEALTHY: "text-emerald-400 border-emerald-500/40 bg-emerald-500/10",
  DEGRADED: "text-amber-400 border-amber-500/40 bg-amber-500/10",
  STALE: "text-orange-400 border-orange-500/40 bg-orange-500/10",
  HALTED: "text-red-400 border-red-500/40 bg-red-500/10",
};

function fmtMs(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v < 1000) return `${v}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  if (v < 3_600_000) return `${(v / 60_000).toFixed(1)}m`;
  return `${(v / 3_600_000).toFixed(1)}h`;
}

export function OpsPanel({ data }: { data: OpsHealthResult }) {
  return (
    <div className="min-h-screen bg-background text-foreground px-4 py-8 md:px-10 space-y-6">
      <header className="flex items-center justify-between border-b border-border/40 pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Operations</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Server-recorded telemetry. Precision and timing are engineering targets measured by
            this panel — not guarantees of successful or profitable trades. Mainnet is{" "}
            <span className={data.mainnet_enabled ? "text-red-400" : "text-emerald-400"}>
              {data.mainnet_enabled ? "ENABLED" : "DISABLED"}
            </span>{" "}
            (paper only).
          </p>
        </div>
        <div className={`px-3 py-1.5 rounded-md border text-xs font-mono uppercase ${STATE_COLOR[data.fleet_state]}`}>
          FLEET · {data.fleet_state}
        </div>
      </header>

      <MonitoringWalletsPanel />

      <section>
        <h2 className="text-sm font-medium mb-3 text-muted-foreground uppercase tracking-wider">Components</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {data.components.map((c) => (
            <div key={c.component} className={`border rounded-lg p-4 ${STATE_COLOR[c.state]}`}>
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs">{c.component}</span>
                <span className="text-xs font-semibold">{c.state}</span>
              </div>
              <dl className="mt-3 space-y-1 text-xs">
                <div className="flex justify-between"><dt className="text-muted-foreground">freshness</dt><dd>{fmtMs(c.freshness_ms)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">backlog</dt><dd>{c.backlog}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">p50 / p95</dt><dd>{fmtMs(c.p50_latency_ms)} / {fmtMs(c.p95_latency_ms)}</dd></div>
              </dl>
              {c.reasons.length > 0 && (
                <ul className="mt-2 text-xs font-mono opacity-80 space-y-0.5">
                  {c.reasons.map((r, i) => <li key={i}>· {r}</li>)}
                </ul>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium mb-3 text-muted-foreground uppercase tracking-wider">Capability Matrix</h2>
        <div className="overflow-hidden border border-border/40 rounded-lg">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">Subsystem</th>
                <th className="text-left px-3 py-2">Role</th>
                <th className="text-left px-3 py-2">Capabilities</th>
                <th className="text-left px-3 py-2">Denies</th>
              </tr>
            </thead>
            <tbody>
              {data.capability_matrix.map((c) => (
                <tr key={c.id} className="border-t border-border/30">
                  <td className="px-3 py-2 font-mono">{c.id}</td>
                  <td className="px-3 py-2">{c.role}</td>
                  <td className="px-3 py-2 text-emerald-400">{c.capabilities.join(", ") || "—"}</td>
                  <td className="px-3 py-2 text-red-400/70">{c.denies.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium mb-3 text-muted-foreground uppercase tracking-wider">Recent Onyx Decisions</h2>
        {data.recent_decisions.length === 0 ? (
          <p className="text-xs text-muted-foreground">No decisions recorded yet.</p>
        ) : (
          <ul className="space-y-1 text-xs font-mono">
            {data.recent_decisions.map((d) => (
              <li key={d.id} className="flex items-center justify-between border border-border/30 rounded px-3 py-1.5">
                <span>{new Date(d.decision_at).toISOString().slice(11, 19)} · {d.symbol} · {d.decision}{d.reject_reason ? ` · ${d.reject_reason}` : ""}</span>
                <span className="text-muted-foreground">{fmtMs(d.decision_latency_ms)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium mb-3 text-muted-foreground uppercase tracking-wider">Correlation Log</h2>
        {data.recent_events.length === 0 ? (
          <p className="text-xs text-muted-foreground">No ops events yet.</p>
        ) : (
          <ul className="space-y-1 text-xs font-mono">
            {data.recent_events.map((e) => (
              <li key={e.id} className="border border-border/30 rounded px-3 py-1.5">
                <span className="text-muted-foreground">{new Date(e.server_ts).toISOString().slice(11, 19)}</span>
                {" · "}
                <span className={e.severity === "error" || e.severity === "critical" ? "text-red-400" : e.severity === "warn" ? "text-amber-400" : ""}>{e.stage}</span>
                {" · "}<span>{e.component}</span>{" · "}<span className="opacity-70">{e.message}</span>
                <span className="ml-2 text-muted-foreground">[{e.correlation_id.slice(0, 8)}]</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
