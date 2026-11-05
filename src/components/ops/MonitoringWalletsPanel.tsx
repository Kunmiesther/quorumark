import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  createTurtleMonitoringWallets,
  getMonitoringWalletTelemetry,
  type MonitoringWalletTelemetry,
} from "@/lib/wallets/monitoring.functions";
import { Button } from "@/components/ui/button";

function fmtDollars(v: number): string {
  return `$${v.toFixed(2)}`;
}
function fmtAge(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

function DirBadge({ dir }: { dir: string }) {
  const cls =
    dir === "long"
      ? "text-emerald-400 border-emerald-500/40 bg-emerald-500/10"
      : dir === "short"
      ? "text-rose-400 border-rose-500/40 bg-rose-500/10"
      : "text-muted-foreground border-border/40 bg-muted/10";
  return (
    <span className={`px-1.5 py-0.5 rounded-sm text-[10px] uppercase tracking-wider border ${cls}`}>
      {dir}
    </span>
  );
}

export function MonitoringWalletsPanel() {
  const qc = useQueryClient();
  const fetchTelemetry = useServerFn(getMonitoringWalletTelemetry);
  const createFn = useServerFn(createTurtleMonitoringWallets);
  const query = useQuery({
    queryKey: ["monitoring-wallets"],
    queryFn: () => fetchTelemetry(),
    refetchInterval: 15_000,
  });
  const create = useMutation({
    mutationFn: () => createFn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["monitoring-wallets"] }),
  });

  const rows: MonitoringWalletTelemetry[] = query.data ?? [];

  return (
    <section className="rounded-lg border border-border/40 bg-card/40 p-4 space-y-3">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium">Monitoring wallets</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Simulated paper ledgers. No seed phrase, no private key, no deposit address, no real money.
            Execution stays disabled until the operational happy-path passes.
          </p>
        </div>
        {rows.length < 2 && (
          <Button
            size="sm"
            variant="outline"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Creating…" : "Create monitoring wallets"}
          </Button>
        )}
      </header>

      {query.isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          No monitoring wallets yet. Click "Create monitoring wallets" to provision two owner-scoped
          simulated wallets (idempotent — retries return the same rows).
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {rows.map((w) => (
            <div
              key={w.id}
              className="border border-border/40 rounded-md p-3 bg-background/40 text-xs space-y-2"
            >
              <div className="flex items-center justify-between">
                <div className="font-mono text-sm">{w.wallet_key}</div>
                <DirBadge dir={w.direction_scope} />
              </div>
              <div className="grid grid-cols-2 gap-y-1 gap-x-3 text-[11px]">
                <span className="text-muted-foreground">ID</span>
                <span className="font-mono">{w.redacted_id}</span>
                <span className="text-muted-foreground">Environment</span>
                <span>{w.environment}</span>
                <span className="text-muted-foreground">Balance source</span>
                <span>{w.balance_source}</span>
                <span className="text-muted-foreground">Status</span>
                <span>{w.status}</span>
                <span className="text-muted-foreground">Balance</span>
                <span>{fmtDollars(w.balance)}</span>
                <span className="text-muted-foreground">Available</span>
                <span>{fmtDollars(w.available_balance)}</span>
                <span className="text-muted-foreground">Reserved</span>
                <span>{fmtDollars(w.reserved_balance)}</span>
                <span className="text-muted-foreground">Exposure</span>
                <span>{fmtDollars(w.exposure_notional)}</span>
                <span className="text-muted-foreground">Execution</span>
                <span className={w.execution_enabled ? "text-emerald-400" : "text-amber-400"}>
                  {w.execution_enabled ? "enabled" : "disabled"}
                </span>
                <span className="text-muted-foreground">Blocked reason</span>
                <span>{w.blocked_reason ?? "—"}</span>
                <span className="text-muted-foreground">Last signal</span>
                <span>{fmtAge(w.last_signal_at)}</span>
                <span className="text-muted-foreground">Last decision</span>
                <span>{fmtAge(w.last_decision_at)}</span>
                <span className="text-muted-foreground">Last intent</span>
                <span>{fmtAge(w.last_intent_at)}</span>
                <span className="text-muted-foreground">Last fill</span>
                <span>{fmtAge(w.last_fill_at)}</span>
                <span className="text-muted-foreground">Last failure</span>
                <span>{fmtAge(w.last_failure_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
