/**
 * Turtle monitoring wallet server functions.
 *
 * Idempotent creation of the two owner-scoped paper monitor wallets:
 *   - TURTLE-MONITOR-LONG-01   (direction_scope=long,  $500 simulated)
 *   - TURTLE-MONITOR-SHORT-01  (direction_scope=short, $500 simulated)
 *
 * Rules enforced by the DB (see migration):
 *   - environment=paper, status=monitoring, balance_source=simulated
 *   - execution_enabled=false by default (server-controlled activation)
 *   - never networked to mainnet; never a real address/credential
 *   - owner-scoped RLS + SECURITY DEFINER RPC with auth.uid() check
 *   - retries return the same two rows (never duplicates)
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface MonitoringWallet {
  id: string;
  wallet_key: string;
  direction_scope: "long" | "short" | "any";
  balance: number;
  status: "active" | "monitoring" | "disabled";
  environment: "paper" | "mainnet";
  balance_source: "simulated" | "verified";
  monitor_role: string | null;
  execution_enabled: boolean;
  activated_at: string | null;
  created_at: string;
  created_this_call: boolean;
  /** Server-derived redacted display id, never exposes raw UUID prefixes. */
  redacted_id: string;
}

function redact(id: string): string {
  if (!id || id.length < 8) return "wallet:****";
  return `wallet:${id.slice(0, 4)}…${id.slice(-4)}`;
}

export const createTurtleMonitoringWallets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MonitoringWallet[]> => {
    const { supabase, userId } = context;
    const { data, error } = await supabase.rpc(
      "create_turtle_monitoring_wallets" as never,
      { _user_id: userId } as never,
    ) as unknown as {
      data: Array<{
        id: string;
        wallet_key: string;
        direction_scope: string;
        balance: number;
        status: string;
        environment: string;
        balance_source: string;
        monitor_role: string | null;
        execution_enabled: boolean;
        activated_at: string | null;
        created_at: string;
        created: boolean;
      }> | null;
      error: { message: string } | null;
    };
    if (error) throw new Error(`monitoring_wallet_rpc_failed: ${error.message}`);
    const rows = data ?? [];
    return rows.map((r) => ({
      id: r.id,
      wallet_key: r.wallet_key,
      direction_scope: r.direction_scope as "long" | "short" | "any",
      balance: Number(r.balance),
      status: r.status as "active" | "monitoring" | "disabled",
      environment: r.environment as "paper" | "mainnet",
      balance_source: r.balance_source as "simulated" | "verified",
      monitor_role: r.monitor_role,
      execution_enabled: r.execution_enabled,
      activated_at: r.activated_at,
      created_at: r.created_at,
      created_this_call: r.created,
      redacted_id: redact(r.id),
    }));
  });

export interface MonitoringWalletTelemetry extends MonitoringWallet {
  reserved_balance: number;
  available_balance: number;
  exposure_notional: number;
  open_position_ids: string[];
  last_signal_at: string | null;
  last_decision_at: string | null;
  last_intent_at: string | null;
  last_fill_at: string | null;
  last_failure_at: string | null;
  blocked_reason: string | null;
}

/**
 * Read-only owner-scoped snapshot for the Ops panel. Never triggers writes,
 * never contacts execution surfaces. Returns the two monitor wallets plus
 * per-wallet telemetry aggregated from paper_positions / ops_events / bot_events.
 */
export const getMonitoringWalletTelemetry = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MonitoringWalletTelemetry[]> => {
    const { supabase, userId } = context;

    const { data: walletRows } = await supabase
      .from("paper_wallets")
      .select(
        "id, wallet_key, balance, direction_scope, status, environment, balance_source, monitor_role, execution_enabled, activated_at, created_at, open_position_id",
      )
      .eq("user_id", userId)
      .eq("status", "monitoring")
      .order("wallet_key");
    const wallets = (walletRows ?? []) as Array<{
      id: string; wallet_key: string; balance: number; direction_scope: string;
      status: string; environment: string; balance_source: string;
      monitor_role: string | null; execution_enabled: boolean;
      activated_at: string | null; created_at: string; open_position_id: string | null;
    }>;
    if (!wallets.length) return [];

    const keys = wallets.map((w) => w.wallet_key);

    const [{ data: positions }, { data: events }] = await Promise.all([
      supabase
        .from("paper_positions")
        .select("id, wallet_key, size_notional, margin, status")
        .eq("user_id", userId)
        .in("wallet_key", keys),
      supabase
        .from("ops_events" as never)
        .select("stage, component, severity, message, detail, server_ts")
        .eq("user_id", userId)
        .order("server_ts", { ascending: false })
        .limit(200) as unknown as { data: Array<{ stage: string; component: string; severity: string; message: string; detail: Record<string, unknown> | null; server_ts: string }> | null },
    ]);

    const posByWallet = new Map<string, Array<{ id: string; margin: number; notional: number; status: string }>>();
    for (const p of (positions ?? []) as Array<{ id: string; wallet_key: string; size_notional: number; margin: number; status: string }>) {
      const list = posByWallet.get(p.wallet_key) ?? [];
      list.push({ id: p.id, margin: Number(p.margin ?? 0), notional: Number(p.size_notional ?? 0), status: p.status });
      posByWallet.set(p.wallet_key, list);
    }

    const stagesForWallet = (walletKey: string) => {
      const bucket = { signal: null as string | null, decision: null as string | null, intent: null as string | null, fill: null as string | null, failure: null as string | null };
      for (const e of events ?? []) {
        const detailKey = (e.detail && typeof e.detail === "object" && "wallet_key" in e.detail) ? String((e.detail as { wallet_key?: unknown }).wallet_key ?? "") : "";
        if (detailKey && detailKey !== walletKey) continue;
        if (bucket.signal == null && e.stage === "scout_scan") bucket.signal = e.server_ts;
        if (bucket.decision == null && e.stage === "onyx_decision") bucket.decision = e.server_ts;
        if (bucket.intent == null && e.stage === "paper_intent") bucket.intent = e.server_ts;
        if (bucket.fill == null && e.stage === "paper_fill") bucket.fill = e.server_ts;
        if (bucket.failure == null && e.severity === "error") bucket.failure = e.server_ts;
      }
      return bucket;
    };

    return wallets.map((w): MonitoringWalletTelemetry => {
      const openPositions = (posByWallet.get(w.wallet_key) ?? []).filter((p) => p.status === "open");
      const reserved = openPositions.reduce((a, p) => a + p.margin, 0);
      const exposure = openPositions.reduce((a, p) => a + p.notional, 0);
      const stages = stagesForWallet(w.wallet_key);
      const blocked = !w.execution_enabled
        ? "execution_disabled_by_default"
        : w.status !== "monitoring"
        ? `wallet_status_${w.status}`
        : null;
      return {
        id: w.id,
        wallet_key: w.wallet_key,
        direction_scope: w.direction_scope as "long" | "short" | "any",
        balance: Number(w.balance),
        status: w.status as "active" | "monitoring" | "disabled",
        environment: w.environment as "paper" | "mainnet",
        balance_source: w.balance_source as "simulated" | "verified",
        monitor_role: w.monitor_role,
        execution_enabled: w.execution_enabled,
        activated_at: w.activated_at,
        created_at: w.created_at,
        created_this_call: false,
        redacted_id: redact(w.id),
        reserved_balance: reserved,
        available_balance: Math.max(0, Number(w.balance) - reserved),
        exposure_notional: exposure,
        open_position_ids: openPositions.map((p) => p.id),
        last_signal_at: stages.signal,
        last_decision_at: stages.decision,
        last_intent_at: stages.intent,
        last_fill_at: stages.fill,
        last_failure_at: stages.failure,
        blocked_reason: blocked,
      };
    });
  });
