import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Lock, ChevronLeft, ChevronRight, Sparkles, Check, Radar } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { turtleByAnyKey, turtleImage, turtleAccent } from "@/lib/turtles";
import { AutopilotPlannerModal } from "@/components/turtle/AutopilotPlannerModal";
import { TurtlePlanEditor } from "@/components/turtle/TurtlePlanEditor";
import { openScout } from "@/components/scout/ScoutPanel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type Tier = "free" | "ion" | "arc" | "orb" | "zen";

interface Strategy {
  id: string;
  slug: string;
  name: string;
  suit_name: string;
  description: string;
  markets: "spot" | "futures" | "both";
  risk: "low" | "medium" | "high";
  ring_color: string;
  trait: string;
}

interface Wallet {
  id: string;
  exchange: string;
  status: string;
}

interface UserStrategyAssignment {
  strategy_id: string;
  market_type: string;
  enabled: boolean;
  mode: string;
  params: unknown;
}

const TURTLE_KEY: Record<string, string> = {
  dca: "accumulator",
  "break-retest": "vanguard",
  "rsi-divergence": "sniper",
  "liq-hunting": "hunter",
  "funding-arb": "arbiter",
};

function assignedTurtles(rows: UserStrategyAssignment[]): Set<string> {
  const result = new Set<string>();
  for (const row of rows) {
    if (!row.params || typeof row.params !== "object" || Array.isArray(row.params)) continue;
    const enabled = (row.params as { enabled_turtles?: unknown }).enabled_turtles;
    if (Array.isArray(enabled)) {
      for (const turtle of enabled) if (typeof turtle === "string") result.add(turtle);
    }
  }
  return result;
}

// Tier → unlocked strategy slugs
// Product tiers are cumulative. Scout is reconnaissance and is never counted
// as a strategy unlock.
const TIER_UNLOCKS: Record<Tier, string[]> = {
  free: ["dca"],
  ion: ["dca", "break-retest"],
  arc: ["dca", "break-retest", "rsi-divergence"],
  orb: ["dca", "break-retest", "rsi-divergence", "funding-arb", "liq-hunting"],
  zen: ["dca", "break-retest", "rsi-divergence", "funding-arb", "liq-hunting"],
};

// User-facing tier label that unlocks a given strategy
const STRATEGY_REQUIRES: Record<string, "Arbiter" | "Operator"> = {
  "break-retest": "Arbiter",
  "rsi-divergence": "Arbiter",
  "ema-cross": "Operator",
  "funding-arb": "Operator",
  "liq-hunting": "Operator",
};

export function SuiteSelectCard({
  embedded = false,
  setupBook = "paper",
}: { embedded?: boolean; setupBook?: "paper" | "live" } = {}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const {
    data: strategies = [],
    isLoading: strategiesLoading,
    isError: strategiesFailed,
    refetch: refetchStrategies,
  } = useQuery({
    queryKey: ["strategies"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("strategies")
        .select("id, slug, name, suit_name, description, markets, risk, ring_color, trait")
        .order("sort_order");
      if (error) throw error;
      return data as Strategy[];
    },
  });

  const {
    data: subscription,
    isPending: subscriptionPending,
    isError: subscriptionFailed,
  } = useQuery({
    queryKey: ["subscription", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("subscriptions")
        .select("tier")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const {
    data: isAdmin = false,
    isPending: accessPending,
    isError: accessFailed,
    refetch: refetchAccess,
  } = useQuery({
    queryKey: ["is-admin", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user!.id)
        .eq("role", "admin")
        .maybeSingle();
      if (error) throw error;
      return !!data;
    },
  });

  const { data: assignments = [] } = useQuery({
    queryKey: ["configured-strategies", user?.id, setupBook],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_strategy")
        .select("strategy_id, market_type, enabled, mode, params")
        .eq("user_id", user!.id)
        .order("symbol", { ascending: true });
      if (error) throw error;
      const rows = (data ?? []).filter((row) => row.mode === setupBook) as UserStrategyAssignment[];
      if (setupBook === "paper") {
        const plans = await supabase
          .from("autopilot_workflows")
          .select("id,strategy_id,status,proposal,enabled_turtles")
          .eq("user_id", user!.id)
          .neq("status", "archived");
        if (plans.error) throw plans.error;
        for (const plan of plans.data ?? []) {
          const proposal = plan.proposal as {
            setupBook?: string;
            paperRouteVersion?: number;
          } | null;
          if (proposal?.setupBook !== "paper" || proposal.paperRouteVersion !== 1) continue;
          rows.push({
            strategy_id: plan.strategy_id,
            market_type: "futures",
            mode: "paper",
            enabled: ["paper_validation", "live_eligible"].includes(plan.status),
            params: { autopilot_workflow_id: plan.id, enabled_turtles: plan.enabled_turtles },
          });
        }
      }
      return rows;
    },
  });

  const { data: wallets = [] } = useQuery({
    queryKey: ["exchange-connections", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("exchange_connections")
        .select("id, exchange, status")
        .eq("user_id", user!.id);
      if (error) throw error;
      return (data ?? []) as Wallet[];
    },
  });

  const tier = (subscription?.tier as Tier | undefined) ?? "free";
  const checkingAccess = accessPending || (!isAdmin && subscriptionPending);
  const accessUnavailable = accessFailed || (!isAdmin && subscriptionFailed);
  const unlocked = useMemo(
    () =>
      isAdmin || setupBook === "paper"
        ? new Set([
            "dca",
            "break-retest",
            "rsi-divergence",
            "ema-cross",
            "funding-arb",
            "liq-hunting",
          ])
        : new Set(TIER_UNLOCKS[tier]),
    [tier, isAdmin, setupBook],
  );
  const tradingStrategies = useMemo(
    () => strategies.filter((strategy) => strategy.slug !== "ema-cross"),
    [strategies],
  );
  const mandateTurtles = useMemo(() => assignedTurtles(assignments), [assignments]);
  const configuredTradingCount = tradingStrategies.filter((strategy) =>
    mandateTurtles.has(TURTLE_KEY[strategy.slug]),
  ).length;

  const [planning, setPlanning] = useState<Strategy | null>(null);
  const [upgradeFor, setUpgradeFor] = useState<Strategy | null>(null);

  function onCardClick(s: Strategy) {
    if (checkingAccess || accessUnavailable) return;
    if (s.slug === "ema-cross") {
      openScout();
      return;
    }
    if (!unlocked.has(s.slug)) {
      setUpgradeFor(s);
      return;
    }
    setPlanning(s);
  }

  return (
    <section id="automation" className={embedded ? "" : "mx-5 mt-4"}>
      <div
        className={
          embedded
            ? "tb-neu-panel rounded-[28px] p-4"
            : "rounded-[22px] border border-white/10 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-4 backdrop-blur-xl"
        }
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-[15px] font-semibold uppercase tracking-[0.14em]">
              Autopilot
            </h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Configure trading Turtles here. Scout handles reconnaissance separately.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-cyan-300/20 bg-cyan-300/[0.06] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-cyan-200">
              {configuredTradingCount}/{tradingStrategies.length} strategies
            </span>
            {embedded ? (
              <button
                type="button"
                disabled={
                  strategiesLoading ||
                  tradingStrategies.every((strategy) => !unlocked.has(strategy.slug))
                }
                onClick={() => {
                  const first = tradingStrategies.find((strategy) => unlocked.has(strategy.slug));
                  if (first) setPlanning(first);
                }}
                className="rounded-full border border-violet-400/30 px-3 py-1.5 text-[10px] font-semibold text-violet-200 disabled:opacity-40"
              >
                Build with Onyx
              </button>
            ) : null}
            <span className="rounded-full border border-white/10 bg-inset px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {isAdmin
                ? "Owner"
                : tier === "free"
                  ? "Free"
                  : tier === "ion"
                    ? "ION"
                    : tier === "arc"
                      ? "ARC"
                      : tier.toUpperCase()}
            </span>
          </div>
        </div>

        {accessUnavailable && (
          <div role="alert" className="mb-3 text-xs text-amber-200">
            Turtle access could not be checked. Your strategies have not been locked or changed.
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => {
                void refetchAccess();
                void qc.invalidateQueries({ queryKey: ["subscription", user?.id] });
              }}
            >
              Retry access check
            </button>
          </div>
        )}
        <Carousel>
          {strategiesLoading && (
            <div className="flex h-[160px] w-full items-center justify-center rounded-[20px] border border-white/[0.06] bg-black/20 text-xs text-muted-foreground">
              Loading available Turtles…
            </div>
          )}
          {!strategiesLoading && strategies.length === 0 && (
            <div className="flex min-h-[160px] w-full flex-col items-center justify-center rounded-[20px] border border-dashed border-white/10 bg-black/20 px-5 text-center">
              <p className="text-sm font-semibold text-white">
                {strategiesFailed
                  ? "Strategy catalog unavailable"
                  : "No strategies are available yet"}
              </p>
              <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
                Autopilot will not activate without a verified strategy. Refresh the catalog or
                check your exchange connection.
              </p>
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="outline" onClick={() => refetchStrategies()}>
                  Refresh catalog
                </Button>
                <Button size="sm" onClick={() => navigate({ to: "/exchanges" })}>
                  Check connection
                </Button>
              </div>
            </div>
          )}
          {strategies.map((s) => {
            const isUnlocked = s.slug === "ema-cross" || unlocked.has(s.slug);
            const isScout = s.slug === "ema-cross";
            const strategyAssignments = assignments.filter((row) => {
              if (assignedTurtles([row]).has(TURTLE_KEY[s.slug])) return true;
              return row.strategy_id === s.id && mandateTurtles.size === 0;
            });
            const isConfigured = strategyAssignments.length > 0;
            const isLive = strategyAssignments.some((row) => row.enabled && row.mode === "live");
            const isLiveConfigured = strategyAssignments.some((row) => row.mode === "live");
            const isPaper = strategyAssignments.some((row) => row.enabled && row.mode !== "live");
            const t = turtleByAnyKey(s.slug);
            const accent = turtleAccent(s.slug);
            const displayName = t?.name ?? s.suit_name;
            const suitLabel = t?.suit ?? s.suit_name;
            return (
              <button
                key={s.id}
                onClick={() => onCardClick(s)}
                disabled={checkingAccess || accessUnavailable}
                aria-label={`${displayName} — ${checkingAccess ? "checking access" : accessUnavailable ? "access check failed" : isScout ? "open Scout" : isUnlocked ? "open configuration" : "locked, requires upgrade"}`}
                className="group relative flex h-[216px] w-[154px] shrink-0 snap-start flex-col overflow-hidden rounded-[18px] border text-left transition focus:outline-none focus:ring-2 focus:ring-[var(--primary)] lg:w-full"
                style={
                  {
                    borderColor: isUnlocked ? `${accent}55` : "rgba(255,255,255,0.08)",
                    boxShadow: isConfigured
                      ? `0 0 0 1px ${accent}, 0 18px 40px -20px ${accent}99`
                      : isUnlocked
                        ? `0 0 0 1px ${accent}18, 0 16px 40px -28px ${accent}55`
                        : "0 16px 40px -28px rgba(0,0,0,0.9)",
                    ["--turtle-accent" as string]: accent,
                  } as React.CSSProperties
                }
              >
                {/* Biome art */}
                <img
                  src={turtleImage(s.slug)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className={`absolute inset-0 h-full w-full object-cover object-top transition duration-500 ${
                    isUnlocked ? "group-hover:scale-[1.04]" : "scale-100"
                  }`}
                />
                {/* Obsidian scrim */}
                <div
                  aria-hidden
                  className="absolute inset-0"
                  style={{
                    background:
                      "linear-gradient(180deg, rgba(10,10,14,0.15) 0%, rgba(10,10,14,0.35) 45%, rgba(10,10,14,0.9) 82%, rgba(10,10,14,0.96) 100%)",
                  }}
                />
                {isUnlocked && (
                  <div
                    aria-hidden
                    className="absolute inset-0 opacity-70 mix-blend-screen"
                    style={{
                      background: `radial-gradient(120% 60% at 50% 100%, ${accent}22, transparent 70%)`,
                    }}
                  />
                )}

                {/* Top-right status pill */}
                <div className="relative flex items-start justify-end p-2.5">
                  {checkingAccess || accessUnavailable ? (
                    <span className="text-[9px] text-white/65">
                      {checkingAccess ? "Checking access…" : "Access unavailable"}
                    </span>
                  ) : !isUnlocked ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-black/45 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-white/85">
                      <Lock className="h-2.5 w-2.5" /> Locked
                    </span>
                  ) : isScout ? (
                    <span
                      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em]"
                      style={{
                        color: accent,
                        borderColor: `${accent}88`,
                        background: `${accent}1a`,
                        borderWidth: 1,
                      }}
                    >
                      <Radar className="h-2.5 w-2.5" /> Recon
                    </span>
                  ) : isLive ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300/40 bg-emerald-300/[0.1] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-emerald-200">
                      <Check className="h-2.5 w-2.5" /> Live armed
                    </span>
                  ) : isPaper && setupBook === "paper" ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-cyan-300/35 bg-cyan-300/[0.08] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-cyan-200">
                      <Check className="h-2.5 w-2.5" /> Paper
                    </span>
                  ) : isLiveConfigured && setupBook === "live" ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-cyan-300/35 bg-cyan-300/[0.08] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-cyan-200">
                      <Check className="h-2.5 w-2.5" /> Live configured
                    </span>
                  ) : isConfigured && setupBook === "paper" ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-black/35 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-white/65">
                      Paused
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-black/35 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-white/55">
                      Not configured
                    </span>
                  )}
                </div>

                {/* Bottom identity */}
                <div className="relative mt-auto p-3">
                  <p
                    className="text-[9px] font-semibold uppercase tracking-[0.18em]"
                    style={{ color: accent }}
                  >
                    {suitLabel}
                  </p>
                  <p className="mt-0.5 font-display text-[18px] font-semibold uppercase leading-none tracking-[0.02em] text-white">
                    {displayName}
                  </p>
                  {isConfigured && wallets[0] && !isScout && (
                    <p className="mt-1.5 truncate text-[10px] text-white/70">
                      {wallets[0].exchange}
                    </p>
                  )}
                  {isUnlocked && !checkingAccess && !accessUnavailable && (
                    <span className="mt-2 inline-flex rounded-full border border-white/20 bg-black/40 px-2 py-1 text-[10px] font-semibold text-white">
                      {isScout ? "Open Scout" : "Configure strategy →"}
                    </span>
                  )}
                  {(!isConfigured || isScout) && (
                    <p className="mt-1.5 line-clamp-1 text-[10px] text-white/65">
                      {t?.role ?? s.description}
                    </p>
                  )}
                </div>

                {(checkingAccess || accessUnavailable || !isUnlocked) && (
                  <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-1 bg-black/55 px-3 py-3 text-center backdrop-blur-sm">
                    <p className="text-[10px] font-semibold leading-tight text-white/90">
                      {checkingAccess
                        ? "Checking access…"
                        : accessUnavailable
                          ? "Access check unavailable"
                          : `Upgrade to ${STRATEGY_REQUIRES[s.slug] ?? "Operator"}`}
                    </p>
                  </div>
                )}
              </button>
            );
          })}
        </Carousel>
        {!checkingAccess && !accessUnavailable && (
          <TurtlePlanEditor
            book={setupBook}
            choices={tradingStrategies
              .filter((item) => unlocked.has(item.slug))
              .map((item) => ({ key: TURTLE_KEY[item.slug], label: item.suit_name }))}
          />
        )}
      </div>

      {/* Upgrade prompt */}
      <Dialog open={!!upgradeFor} onOpenChange={(o) => !o && setUpgradeFor(null)}>
        <DialogContent className="max-w-sm rounded-2xl border-white/10 bg-background/95 backdrop-blur-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-gold" />
              Unlock {upgradeFor?.suit_name}
            </DialogTitle>
            <DialogDescription>
              {upgradeFor && (
                <>
                  Upgrade to the{" "}
                  <span className="font-semibold text-foreground">
                    {STRATEGY_REQUIRES[upgradeFor.slug] ?? "Operator"}
                  </span>{" "}
                  tier to run {upgradeFor.suit_name} and access more strategies.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setUpgradeFor(null)}>
              Not now
            </Button>
            <Button
              onClick={() => {
                setUpgradeFor(null);
                navigate({ to: "/profile" });
              }}
            >
              View pricing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Strategy configuration */}
      {planning && (
        <AutopilotPlannerModal
          setupBook={setupBook}
          strategy={planning}
          availableStrategies={tradingStrategies.filter((item) => unlocked.has(item.slug))}
          onClose={() => setPlanning(null)}
          onContinue={() => {
            qc.invalidateQueries({ queryKey: ["autopilot-workflows", user?.id] });
            setPlanning(null);
          }}
        />
      )}
    </section>
  );
}

function Carousel({ children }: { children: React.ReactNode }) {
  let ref: HTMLDivElement | null = null;
  const scrollBy = (dx: number) => ref?.scrollBy({ left: dx, behavior: "smooth" });
  return (
    <div className="relative">
      <div
        ref={(el) => {
          ref = el;
        }}
        className="flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth pb-2 [scrollbar-width:thin] lg:grid lg:grid-cols-3 xl:grid-cols-6"
      >
        {children}
      </div>
      <button
        type="button"
        aria-label="Scroll left"
        onClick={() => scrollBy(-200)}
        className="absolute -left-1 top-1/2 hidden h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-background/80 backdrop-blur sm:flex"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label="Scroll right"
        onClick={() => scrollBy(200)}
        className="absolute -right-1 top-1/2 hidden h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-background/80 backdrop-blur sm:flex"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}
