import { useWorkerHealth } from "@/hooks/useWorkerHealth";
import { formatHeartbeatAge, workerStateLabel } from "@/lib/health/workerHealth";
import { CheckCircle2, AlertTriangle, CircleDashed, Activity } from "lucide-react";

/**
 * Authoritative worker status panel.
 * Source: `public.worker_heartbeats` (production/live worker) only.
 * The legacy `public.bot_heartbeat` row is never consulted here.
 */
export function BotStatusPanel() {
  const { health, isLoading } = useWorkerHealth();

  const credsOk = health.credentialsOk === true;
  const isHealthy = health.state === "healthy";

  return (
    <section
      aria-label="Bot status"
      className="rounded-2xl border border-border bg-card/60 p-4 shadow-sm"
    >
      <header className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold tracking-wide">Bot Status</h2>
        </div>
        <span
          className={
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium " +
            (isHealthy
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-amber-500/10 text-amber-600 dark:text-amber-400")
          }
        >
          <span
            className={
              "h-1.5 w-1.5 rounded-full " +
              (isHealthy ? "bg-emerald-500 animate-pulse" : "bg-amber-500")
            }
          />
          {isLoading ? "Checking…" : workerStateLabel(health.state)}
        </span>
      </header>

      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground mb-1">Worker</dt>
          <dd className="font-medium break-all">{health.workerId ?? "—"}</dd>
        </div>

        <div>
          <dt className="text-xs text-muted-foreground mb-1">Environment</dt>
          <dd className="font-medium">{health.environment ?? "—"}</dd>
        </div>

        <div>
          <dt className="text-xs text-muted-foreground mb-1">Credentials</dt>
          <dd className="flex items-center gap-1.5 font-medium">
            {credsOk ? (
              <>
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                Loaded
              </>
            ) : (
              <>
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                {health.credentialsOk === false ? "Missing" : "Unknown"}
              </>
            )}
          </dd>
        </div>

        <div>
          <dt className="text-xs text-muted-foreground mb-1">Mode</dt>
          <dd className="flex items-center gap-1.5 font-medium">
            {health.mode === "live" ? (
              <>
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                Live
              </>
            ) : (
              <>
                <CircleDashed className="h-4 w-4 text-muted-foreground" />
                {health.mode ?? "—"}
              </>
            )}
          </dd>
        </div>

        <div className="col-span-2">
          <dt className="text-xs text-muted-foreground mb-1">Last heartbeat</dt>
          <dd className="font-medium">{formatHeartbeatAge(health.ageMs)}</dd>
        </div>

        <div className="col-span-2">
          <dt className="text-xs text-muted-foreground mb-1">Detail</dt>
          <dd className="text-xs text-muted-foreground break-words">{health.reason}</dd>
        </div>
      </dl>

      {!health.ready && (
        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
          Live readiness is blocked until the production worker reports a fresh,
          healthy heartbeat with credentials loaded.
        </p>
      )}
    </section>
  );
}
