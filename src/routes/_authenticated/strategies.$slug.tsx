import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Check, X, ChevronRight } from "lucide-react";

import { CinematicHero } from "@/components/shell/CinematicHero";
import { ProfileAvatar } from "@/components/shell/ProfileAvatar";
import { SurfaceCard } from "@/components/phantom/SurfaceCard";
import { turtleByAnyKey, turtleBySlug, type TurtleDef } from "@/lib/turtles";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export const Route = createFileRoute("/_authenticated/strategies/$slug")({
  loader: ({ params }) => {
    const turtle = turtleByAnyKey(params.slug);
    if (!turtle) throw notFound();
    return { turtle };
  },
  head: ({ loaderData }) => {
    if (!loaderData) {
      return { meta: [{ title: "Turtle — TurtleBot" }, { name: "robots", content: "noindex" }] };
    }
    const t = loaderData.turtle;
    return {
      meta: [
        { title: `${t.suit} — TurtleBot` },
        { name: "description", content: t.role },
      ],
    };
  },
  component: StrategyDetailPage,
  notFoundComponent: NotFoundView,
});

function NotFoundView() {
  return (
    <div className="min-h-[100dvh] bg-black p-6 text-white">
      <SurfaceCard>
        <h1 className="text-[20px] font-semibold">Unknown strategy</h1>
        <p className="mt-2 text-[13px] text-white/60">
          Pick one from the strategy list.
        </p>
        <Link
          to="/strategies"
          className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-[color:var(--accent)] px-4 py-2 text-[13px] font-semibold text-white"
        >
          Back to Strategies
        </Link>
      </SurfaceCard>
    </div>
  );
}

function StrategyDetailPage() {
  const { turtle } = Route.useLoaderData() as { turtle: TurtleDef };

  return (
    <div className="min-h-[100dvh] bg-black text-white">
      <CinematicHero
        image={turtle.image}
        imagePosition="center 30%"
        eyebrow={`Strategy · ${turtle.suit}`}
        title={turtle.name}
        subtitle={turtle.role}
        chrome={
          <div className="flex items-center justify-between gap-2 px-4 pt-4 md:px-8 lg:px-12">
            <Link
              to="/strategies"
              className="rounded-full bg-black/50 px-3 py-1.5 text-[12px] font-semibold text-white/85 backdrop-blur transition hover:bg-black/70"
            >
              ← Strategies
            </Link>
            <ProfileAvatar />
          </div>
        }
      />

      <div className="mx-auto max-w-[900px] space-y-4 px-4 pb-16 pt-6 md:px-6 lg:max-w-[1120px] lg:px-8">
        <ProfilePanel turtle={turtle} />
        <StrategyPanel turtle={turtle} />
        <AssignmentPanel turtle={turtle} />
        {turtle.key === "accumulator" && (
          <SurfaceCard>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/45">
              Advanced configuration
            </p>
            <p className="mt-2 text-[13px] text-white/75">
              Full Arbiter engine — safety orders, target ladder, budget floor.
            </p>
            <Link
              to="/strategies/accumulator/config"
              className="mt-4 inline-flex items-center gap-2 rounded-full bg-[color:var(--accent)] px-4 py-2 text-[13px] font-semibold text-white transition hover:opacity-90"
            >
              Open advanced configuration
              <ChevronRight className="h-4 w-4" />
            </Link>
          </SurfaceCard>
        )}
      </div>
    </div>
  );
}

function ProfilePanel({ turtle }: { turtle: TurtleDef }) {
  return (
    <SurfaceCard>
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/45">
        Profile
      </h2>
      <dl className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Row label="Personality" value={turtle.personality} />
        <Row label="Signature tool" value={turtle.tool} />
        <Row label="Best conditions" value={turtle.bestConditions} />
        <Row label="Biome" value={turtle.biome} />
        <Row label="Risk" value={`${turtle.risk[0]!.toUpperCase()}${turtle.risk.slice(1)} risk`} />
      </dl>
    </SurfaceCard>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10.5px] font-medium uppercase tracking-[0.14em] text-white/45">
        {label}
      </dt>
      <dd className="mt-1 text-[13.5px] text-white">{value}</dd>
    </div>
  );
}

interface StrategyRow {
  id: string;
  slug: string;
  name: string;
  suit_name: string | null;
  trait: string | null;
  risk: string | null;
  markets: string | null;
  description: string | null;
}

function StrategyPanel({ turtle }: { turtle: TurtleDef }) {
  const { data: strategy, isLoading, error } = useQuery({
    queryKey: ["strategy", turtle.slug],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("strategies")
        .select("id, slug, name, suit_name, trait, risk, markets, description")
        .eq("slug", turtle.slug)
        .maybeSingle();
      if (error) throw error;
      return data as StrategyRow | null;
    },
  });

  return (
    <SurfaceCard>
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/45">
        Strategy
      </h2>
      {isLoading ? (
        <p className="mt-3 text-[13px] text-white/50">Loading…</p>
      ) : error ? (
        <p className="mt-3 text-[13px] text-red-300">{(error as Error).message}</p>
      ) : !strategy ? (
        <p className="mt-3 text-[13px] text-white/60">No strategy row yet.</p>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {strategy.trait && <Chip>{strategy.trait}</Chip>}
            {strategy.markets && <Chip>Markets: {strategy.markets}</Chip>}
            {strategy.risk && <Chip>{strategy.risk} risk</Chip>}
          </div>
          {strategy.description && (
            <p className="text-[13.5px] leading-relaxed text-white/80">{strategy.description}</p>
          )}
          <p className="text-[11.5px] leading-relaxed text-white/45">
            Method only. No historical performance is shown — none is established for this account.
          </p>
        </div>
      )}
    </SurfaceCard>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.12em] text-white/60">
      {children}
    </span>
  );
}

interface Connection {
  id: string;
  exchange: string;
  display_name: string | null;
  status: string;
  market_type: "spot" | "futures";
}
interface AssignmentRow {
  connection_id: string;
  strategy_id: string;
}

function AssignmentPanel({ turtle }: { turtle: TurtleDef }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data: strategyRows = [] } = useQuery({
    queryKey: ["strategies", "id-slug-markets"],
    queryFn: async () => {
      const { data, error } = await supabase.from("strategies").select("id, slug, markets");
      if (error) throw error;
      return data as { id: string; slug: string; markets: string | null }[];
    },
  });
  const slugById = new Map(strategyRows.map((s) => [s.id, s.slug]));
  const idBySlug = new Map(strategyRows.map((s) => [s.slug, s.id]));
  const strategyId = idBySlug.get(turtle.slug);
  const strategyMarkets = strategyRows.find((s) => s.slug === turtle.slug)?.markets ?? null;

  const { data: connections = [], isLoading: connLoading } = useQuery({
    queryKey: ["exchange_connections", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("exchange_connections")
        .select("id, exchange, display_name, status, market_type")
        .eq("user_id", user!.id);
      if (error) throw error;
      return (data ?? []) as Connection[];
    },
  });

  const { data: assignments = [] } = useQuery({
    queryKey: ["user_strategy", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_strategy")
        .select("connection_id, strategy_id")
        .eq("user_id", user!.id);
      if (error) throw error;
      return (data ?? []) as AssignmentRow[];
    },
  });

  const ownerByConn = new Map<string, string>();
  for (const a of assignments) {
    const slug = slugById.get(a.strategy_id);
    if (slug) ownerByConn.set(a.connection_id, slug);
  }

  function incompatReason(connMarket: "spot" | "futures"): string | null {
    if (!strategyMarkets || strategyMarkets === "both") return null;
    if (strategyMarkets === connMarket) return null;
    return `${turtle.name} needs ${strategyMarkets} · this connection is ${connMarket}`;
  }


  async function assign(connectionId: string) {
    if (!user || !strategyId) return;
    setBusyId(connectionId);
    try {
      const { error } = await supabase.from("user_strategy").upsert(
        { user_id: user.id, connection_id: connectionId, strategy_id: strategyId },
        { onConflict: "user_id,connection_id,symbol" },
      );
      if (error) throw error;
      toast.success(`Assigned ${turtle.name}`);
      await qc.invalidateQueries({ queryKey: ["user_strategy", user.id] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function unassign(connectionId: string) {
    if (!user) return;
    setBusyId(connectionId);
    try {
      const { error } = await supabase
        .from("user_strategy")
        .delete()
        .eq("user_id", user.id)
        .eq("connection_id", connectionId);
      if (error) throw error;
      toast.success(`Unassigned ${turtle.name}`);
      await qc.invalidateQueries({ queryKey: ["user_strategy", user.id] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <SurfaceCard>
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/45">
        Assignment
      </h2>
      {connLoading ? (
        <p className="mt-3 text-[13px] text-white/50">Loading connections…</p>
      ) : connections.length === 0 ? (
        <div className="mt-3">
          <p className="text-[13px] text-white/60">
            No connections yet. Add an exchange first.
          </p>
          <Link
            to="/exchanges"
            className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[color:var(--accent)] px-4 py-2 text-[13px] font-semibold text-white"
          >
            Go to Exchanges
          </Link>
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {connections.map((c) => {
            const ownerSlug = ownerByConn.get(c.id);
            const isMine = ownerSlug === turtle.slug;
            const otherOwner = ownerSlug && !isMine ? turtleBySlug(ownerSlug) : null;
            const busy = busyId === c.id;
            const label = c.display_name || c.exchange;
            const incompat = incompatReason(c.market_type);
            return (
              <li key={c.id}>
                <div
                  className={`flex min-h-[52px] items-center justify-between gap-3 rounded-2xl px-4 py-3 transition ${
                    isMine ? "bg-white/[0.09] ring-1 ring-[color:var(--accent)]/50" : "bg-white/[0.04]"
                  } ${incompat && !isMine ? "opacity-70" : ""}`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold text-white">{label}</p>
                    <p className="mt-0.5 truncate text-[11px] uppercase tracking-[0.12em] text-white/50">
                      {c.exchange} · {c.market_type} · {c.status}
                      {otherOwner && (
                        <>
                          {" · "}
                          <span style={{ color: otherOwner.accent }}>
                            Held by {otherOwner.name}
                          </span>
                        </>
                      )}
                    </p>
                    {incompat && !isMine && (
                      <p className="mt-1 text-[11px] text-amber-300/90">{incompat}</p>
                    )}
                  </div>
                  {isMine ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => unassign(c.id)}
                      className="inline-flex items-center gap-1 rounded-full bg-white/[0.06] px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-white/70 hover:text-white disabled:opacity-60"
                    >
                      {busy ? "…" : (<><Check className="h-3.5 w-3.5" style={{ color: turtle.accent }} /> Assigned<X className="ml-1 h-3 w-3" /></>)}
                    </button>
                  ) : incompat ? (
                    <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/30">
                      Unavailable
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy || !strategyId}
                      onClick={() => assign(c.id)}
                      className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--accent)] disabled:opacity-60"
                    >
                      {busy ? "Assigning…" : otherOwner ? "Reassign" : "Assign"}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
          <p className="pt-1 text-[11px] leading-relaxed text-white/45">
            Assignment binds this strategy to the connection. It does not enable trading or change mode.
          </p>
        </ul>
      )}
    </SurfaceCard>
  );
}
