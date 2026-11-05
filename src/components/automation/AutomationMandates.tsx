import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { AUTOMATION_VENUES } from "@/lib/automation/liveVenueReadiness";
import { ExchangeIdentity, WalletIdentity } from "@/components/exchanges/ConnectionIdentity";
import { PairBadge } from "@/components/trade/PairBadge";
import { exchangeWalletIdentitiesQuery } from "@/hooks/exchangeWalletIdentities";
import { accountWallets } from "@/lib/wallet/accountIdentity";
import { planExecutionState } from "@/lib/automation/planExecutionState";

type Assignment = { symbol: string; connectionId: string; walletConnectionId: string | null };
type Plan = {
  id: string;
  name: string;
  goal_label: string;
  status: string;
  pause_reason: string | null;
  symbols: string[];
  enabled_turtles: string[];
  margin_pct: number;
  rung_count: number;
  loss_limit: number;
  active_days: number[];
  window_start: string;
  window_end: string;
  proposal: unknown;
  connection_id: string | null;
};

function assignmentsFor(plan: Plan): Assignment[] {
  const proposal =
    plan.proposal && typeof plan.proposal === "object" && !Array.isArray(plan.proposal)
      ? (plan.proposal as Record<string, unknown>)
      : {};
  const saved = proposal.venueAssignments;
  if (Array.isArray(saved)) {
    const assignments = saved.filter(
      (item): item is Assignment =>
        item !== null &&
        typeof item === "object" &&
        typeof item.symbol === "string" &&
        typeof item.connectionId === "string" &&
        (item.walletConnectionId === null || typeof item.walletConnectionId === "string"),
    );
    if (assignments.length === plan.symbols.length) return assignments;
  }
  return plan.symbols.map((symbol) => ({
    symbol,
    connectionId: plan.connection_id ?? "",
    walletConnectionId: null,
  }));
}

export function AutomationMandates() {
  const { user } = useAuth();
  const identities = useQuery(exchangeWalletIdentitiesQuery(user?.id));
  const dataQ = useQuery({
    queryKey: ["automation-mandates-live", user?.id],
    enabled: Boolean(user?.id),
    refetchInterval: 15_000,
    queryFn: async () => {
      const [plans, rows, venues, wallets] = await Promise.all([
        supabase
          .from("autopilot_workflows")
          .select(
            "id,name,goal_label,status,pause_reason,symbols,enabled_turtles,margin_pct,rung_count,loss_limit,active_days,window_start,window_end,proposal,connection_id",
          )
          .eq("user_id", user!.id)
          .neq("status", "archived")
          .order("updated_at", { ascending: false })
          .limit(30),
        supabase
          .from("user_strategy")
          .select("connection_id,symbol,enabled,mode,params")
          .eq("user_id", user!.id),
        supabase
          .from("exchange_connections")
          .select(
            "id,exchange,display_name,status,environment,permission_trade,permissions_verified,is_live",
          )
          .eq("user_id", user!.id),
        supabase
          .from("wallet_connections")
          .select(
            "id,label,public_address,status,is_active,assigned_exchange_connection_id,provider",
          )
          .eq("user_id", user!.id),
      ]);
      const error = plans.error ?? rows.error ?? venues.error ?? wallets.error;
      if (error) throw error;
      const executionRows = rows.data ?? [];
      const livePlans = ((plans.data ?? []) as Plan[]).filter((plan) => {
        const proposal =
          plan.proposal && typeof plan.proposal === "object" && !Array.isArray(plan.proposal)
            ? (plan.proposal as Record<string, unknown>)
            : {};
        return (
          proposal.setupBook === "live" ||
          executionRows.some((row) => {
            const params =
              row.params && typeof row.params === "object" && !Array.isArray(row.params)
                ? (row.params as Record<string, unknown>)
                : {};
            return params.autopilot_workflow_id === plan.id && row.mode === "live";
          })
        );
      });
      return {
        plans: livePlans,
        rows: executionRows,
        venues: new Map((venues.data ?? []).map((venue) => [venue.id, venue])),
        wallets: new Map((wallets.data ?? []).map((wallet) => [wallet.id, wallet])),
      };
    },
  });

  return (
    <section
      className="tb-neu-panel mt-5 min-w-0 rounded-[28px] p-4 lg:p-5"
      aria-labelledby="live-mandates-heading"
    >
      <p className="text-[10px] uppercase tracking-[0.18em] text-violet-300/75">
        Saved configuration
      </p>
      <h2 id="live-mandates-heading" className="mt-1 font-display text-xl">
        Your automations
      </h2>
      <p className="mt-1 text-xs leading-5 text-white/45">
        See the exact Turtle, Life Map target, venue, wallet, and symbol mapping. A saved plan is
        not the same as an active live strategy.
      </p>
      {dataQ.isLoading ? (
        <p className="mt-4 text-xs text-white/45">Loading saved plans and execution rows…</p>
      ) : null}
      {dataQ.isError ? (
        <p role="alert" className="mt-4 text-xs text-rose-200">
          Automation configuration could not be verified.
        </p>
      ) : null}
      {dataQ.isSuccess && dataQ.data.plans.length === 0 ? (
        <div className="tb-neu-inset mt-4 rounded-2xl p-4 text-xs text-white/55">
          No saved Live mandate yet. Use the builder above to choose a Turtle and map its symbols to
          your exchanges and wallets.
        </div>
      ) : null}
      {dataQ.isSuccess ? (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {dataQ.data.plans.map((plan) => {
            const assignments = assignmentsFor(plan);
            const linked = dataQ.data.rows.filter((row) => {
              const params =
                row.params && typeof row.params === "object" && !Array.isArray(row.params)
                  ? (row.params as Record<string, unknown>)
                  : {};
              return params.autopilot_workflow_id === plan.id;
            });
            const state = planExecutionState(plan.status, linked, plan.pause_reason);
            return (
              <article key={plan.id} className="tb-neu-inset min-w-0 rounded-2xl p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-display text-base">{plan.name}</h3>
                    <p className="mt-1 text-xs text-white/45">Life Map: {plan.goal_label}</p>
                  </div>
                  <span
                    className={`rounded-full px-2 py-1 text-[10px] ${state.armed && !state.conflict ? "bg-emerald-400/[0.10] text-emerald-200" : "bg-amber-400/[0.10] text-amber-200"}`}
                  >
                    {state.label}
                  </span>
                </div>
                <p
                  role={state.conflict ? "alert" : undefined}
                  className={`mt-2 text-xs leading-5 ${state.conflict ? "text-amber-200" : "text-white/45"}`}
                >
                  {state.detail}
                </p>
                <p className="mt-3 text-xs text-white/55">
                  {plan.enabled_turtles.join(", ")} · {plan.margin_pct}% current wallet ·{" "}
                  {plan.rung_count} rungs · ${Number(plan.loss_limit).toLocaleString()} loss pause
                </p>
                <p className="mt-1 text-[11px] text-white/35">
                  {plan.active_days.length} days · {plan.window_start.slice(0, 5)}–
                  {plan.window_end.slice(0, 5)}
                </p>
                <div className="mt-3 space-y-1.5">
                  {assignments.map((assignment) => {
                    const venue = dataQ.data.venues.get(assignment.connectionId);
                    const matchedAccounts = accountWallets(
                      [...dataQ.data.wallets.values()],
                      assignment.connectionId,
                      identities.data ?? [],
                    );
                    const wallet = assignment.walletConnectionId
                      ? dataQ.data.wallets.get(assignment.walletConnectionId)
                      : matchedAccounts.length === 1
                        ? matchedAccounts[0]
                        : null;
                    const row = linked.find(
                      (item) =>
                        item.symbol === assignment.symbol &&
                        item.connection_id === assignment.connectionId,
                    );
                    const venueReady =
                      venue?.status === "verified" &&
                      venue.permission_trade &&
                      venue.permissions_verified;
                    const routeSupported =
                      AUTOMATION_VENUES.has(venue?.exchange ?? "") &&
                      ["mainnet", "production", "live"].includes(venue?.environment ?? "");
                    const rowArmed = row?.enabled && row.mode === "live";
                    const rowState = !rowArmed
                      ? "Not live"
                      : !routeSupported
                        ? "Route unverified"
                        : !venueReady
                          ? "Venue blocked"
                          : venue?.is_live !== true
                            ? "Armed · exchange paused"
                            : "Armed";
                    return (
                      <div
                        key={`${assignment.symbol}:${assignment.connectionId}`}
                        className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-xl bg-white/[0.03] px-3 py-2.5 text-xs"
                      >
                        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
                          <strong className="inline-flex items-center gap-1.5">
                            <PairBadge symbol={assignment.symbol} size={20} />
                          </strong>
                          <ExchangeIdentity
                            exchange={venue?.exchange ?? ""}
                            name={venue?.display_name}
                            connectionId={assignment.connectionId}
                          />
                          <WalletIdentity
                            wallet={wallet}
                            emptyLabel={
                              assignment.walletConnectionId
                                ? "Assigned wallet unavailable"
                                : "No wallet assigned · venue account"
                            }
                          />
                          {!assignment.walletConnectionId && wallet ? (
                            <span className="text-[10px] text-cyan-200/70">
                              Exchange account wallet
                            </span>
                          ) : null}
                        </div>
                        <span
                          className={
                            rowArmed && routeSupported && venueReady && venue?.is_live === true
                              ? "text-emerald-200"
                              : "text-amber-200"
                          }
                        >
                          {rowState}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-3 text-[11px] leading-5 text-white/35">
                  A wallet assignment records your intended funding relationship. Actual order
                  signing uses the verified exchange connection, not this wallet label. Armed means
                  configuration is enabled; venue orders and fills below are execution evidence.
                </p>
              </article>
            );
          })}
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        <a href="#automation-operations" className="text-violet-200 hover:text-white">
          Review live controls →
        </a>
        <Link to="/exchanges" className="text-cyan-200 hover:text-white">
          Manage exchanges and wallets →
        </Link>
        <Link to="/life-map" className="text-emerald-200 hover:text-white">
          Manage Life Map →
        </Link>
      </div>
    </section>
  );
}
