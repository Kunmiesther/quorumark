import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Play, Pause, CircleDot } from "lucide-react";
import { toast } from "sonner";
import { turtleImage, turtleAccent } from "@/lib/turtles";
import { TurtleAvatar } from "@/components/turtle/TurtleAvatar";
import { Card, CardContent } from "@/components/ui/card";
import type { Database } from "@/integrations/supabase/types";
import { MarginModeBadge } from "@/components/turtle/MarginModeBadge";
import { useWorkerHealth } from "@/hooks/useWorkerHealth";
import { formatHeartbeatAge, workerStateLabel } from "@/lib/health/workerHealth";

type Profile = Database["public"]["Tables"]["profiles"]["Row"];
type Strategy = Database["public"]["Tables"]["strategies"]["Row"];
type Trade = Database["public"]["Tables"]["trades"]["Row"];

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function formatAgo(iso: string, now: number): string {
  const ms = now - new Date(iso).getTime();
  if (!isFinite(ms) || ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatPnl(n: number): string {
  const abs = Math.abs(n).toFixed(2);
  return `${n >= 0 ? "+" : "−"}$${abs}`;
}

function todayStartIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function BotControlCard() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const now = useNow(1000);
  const [busy, setBusy] = useState(false);

  const { data: profile } = useQuery({
    queryKey: ["profile", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data as Profile | null;
    },
  });

  const { data: active } = useQuery({
    queryKey: ["active-strategy", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_strategy")
        .select("market_type, cross_margin, margin_mode, strategies(*)")
        .eq("user_id", user!.id)
        .order("symbol", { ascending: true })
          .limit(1).maybeSingle();
      if (error) throw error;
      return data as {
        market_type: Database["public"]["Enums"]["account_mode"];
        cross_margin: boolean;
        margin_mode: string | null;
        strategies: Strategy | null;
      } | null;
    },
  });

  const { data: primaryConnection } = useQuery({
    queryKey: ["primary-exchange-connection", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("exchange_connections")
        .select("exchange, environment, market_type, status")
        .eq("user_id", user!.id)
        .neq("status", "disabled")
        .neq("status", "disconnected")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as {
        exchange: string;
        environment: string;
        market_type: Database["public"]["Enums"]["account_mode"];
      } | null;
    },
  });

  // Authoritative runtime health: production/live worker_heartbeats only.
  // The legacy public.bot_heartbeat row is not consulted.
  const { health: workerHealth } = useWorkerHealth();

  const { data: lastTrade } = useQuery({
    queryKey: ["last-trade", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("trades")
        .select("*")
        .eq("user_id", user!.id)
        .order("closed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as Trade | null;
    },
  });

  const { data: todayPnl } = useQuery({
    queryKey: ["today-pnl", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("trades")
        .select("realized_pnl")
        .eq("user_id", user!.id)
        .gte("closed_at", todayStartIso());
      if (error) throw error;
      return (data ?? []).reduce((sum, row) => sum + Number(row.realized_pnl ?? 0), 0);
    },
  });

  const online = workerHealth.state === "healthy";

  const running = profile?.bot_status === "running";
  const mode = workerHealth.mode ?? "unknown";

  const status = useMemo(() => {
    if (!online) {
      return {
        label: workerStateLabel(workerHealth.state),
        tone: "muted" as const,
        dot: "bg-text-muted",
        text: "text-muted-foreground",
      };
    }
    if (running) {
      return {
        label: "Running",
        tone: "positive" as const,
        dot: "bg-positive animate-pulse",
        text: "text-positive",
      };
    }
    return {
      label: "Paused",
      tone: "gold" as const,
      dot: "bg-gold",
      text: "text-gold",
    };
  }, [online, running, workerHealth.state]);

  const strategy = active?.strategies;
  const strategyLabel = strategy
    ? `${strategy.name}${active?.market_type === "futures" ? ` @ ${profile?.current_leverage_tier ?? 1}X` : ""}`
    : "—";

  const pnl = todayPnl ?? 0;

  async function toggle() {
    if (!user || !profile || busy) return;
    setBusy(true);
    const next = profile.bot_status === "running" ? "paused" : "running";
    const prev = profile.bot_status;

    qc.setQueryData(["profile", user.id], (old: Profile | undefined) =>
      old ? { ...old, bot_status: next } : old,
    );

    const { error } = await supabase
      .from("profiles")
      .update({ bot_status: next })
      .eq("id", user.id);

    if (error) {
      qc.setQueryData(["profile", user.id], (old: Profile | undefined) =>
        old ? { ...old, bot_status: prev } : old,
      );
      toast.error(error.message);
    } else {
      const ua = typeof navigator !== "undefined" ? navigator.userAgent : null;
      await supabase.from("bot_status_events").insert({
        user_id: user.id,
        status: next,
        trigger_source: "tap",
        user_agent: ua,
      });
      qc.invalidateQueries({ queryKey: ["profile", user.id] });
      qc.invalidateQueries({ queryKey: ["bot-status-events", user.id] });
      toast.success(next === "running" ? "Bot resumed" : "Bot paused");
    }

    setBusy(false);
  }

  return (
    <Card
      className={`mx-5 mt-4 overflow-hidden transition ${
        running && online
          ? "shadow-[0_0_40px_-16px_rgba(20,241,149,0.25)]"
          : ""
      }`}
    >
      <CardContent className="p-5">
        {/* Header: status + controls */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2.5 w-2.5">
              <span
                className={`absolute inline-flex h-full w-full rounded-full opacity-40 ${status.dot}`}
              />
              <span
                className={`relative inline-flex h-2.5 w-2.5 rounded-full ${status.dot}`}
              />
            </span>
            <div className="flex flex-col">
              <span className={`text-sm font-semibold ${status.text}`}>
                {status.label}
              </span>
              <span className="text-[10.5px] uppercase tracking-wider text-muted-foreground">
                {mode} · {formatHeartbeatAge(workerHealth.ageMs)}
              </span>
            </div>
          </div>

          <button
            onClick={toggle}
            disabled={busy || !profile}
            className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
              running
                ? "bg-primary text-primary-foreground hover:brightness-110"
                : "bg-gold/90 text-[#1a1006] hover:bg-gold"
            }`}
          >
            {running ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4 fill-current" />
            )}
            {running ? "Pause" : "Resume"}
          </button>
        </div>

        {/* Active strategy */}
        <div className="mt-5 flex items-center gap-3.5">
          {strategy ? (
            <TurtleAvatar
              src={turtleImage(strategy.slug)}
              ringColor={turtleAccent(strategy.slug)}
              size={56}
              glow
            />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-full border border-border bg-inset">
              <CircleDot className="h-6 w-6 text-muted-foreground" />
            </div>
          )}
          <div className="min-w-0">
            <h2 className="text-[10.5px] uppercase tracking-wider text-muted-foreground">
              Active strategy
            </h2>
            <p className="truncate text-lg font-semibold leading-tight">
              {strategyLabel}
            </p>
            <MarginModeBadge
              exchange={primaryConnection?.exchange ?? null}
              marketType={active?.market_type ?? null}
              selectedMode={active?.margin_mode ?? null}
            />
          </div>
        </div>

        {/* Next action / heartbeat strip */}
        <div className="mt-4 flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2">
          <span className="relative flex h-2 w-2 shrink-0">
            <span
              className={`absolute inline-flex h-full w-full rounded-full opacity-60 ${
                online ? "bg-primary animate-ping" : "bg-muted-foreground"
              }`}
            />
            <span
              className={`relative inline-flex h-2 w-2 rounded-full ${
                online ? "bg-primary" : "bg-muted-foreground"
              }`}
            />
          </span>
          <p className="min-w-0 flex-1 truncate text-[11.5px] text-foreground/90">
            {online
              ? running
                ? "Watching markets for entry signals…"
                : "Bot paused · no actions queued"
              : workerHealth.reason}
          </p>
          <span className="num shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
            {formatHeartbeatAge(workerHealth.ageMs)}
          </span>
        </div>

        {/* Last trade + P&L */}
        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
            <h2 className="text-[10.5px] uppercase tracking-wider text-muted-foreground">
              Last trade
            </h2>
            <p className="num mt-1 text-[15px] font-semibold">
              {lastTrade ? formatAgo(lastTrade.closed_at, now) : "—"}
            </p>
            {lastTrade && (
              <p className="num mt-0.5 text-[11px] text-muted-foreground">
                {lastTrade.pair} · {formatPnl(Number(lastTrade.realized_pnl))}
              </p>
            )}
          </div>

          <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
            <h2 className="text-[10.5px] uppercase tracking-wider text-muted-foreground">
              Today&apos;s P&amp;L
            </h2>
            <p
              className={`num mt-1 text-[15px] font-semibold ${
                pnl >= 0 ? "text-positive" : "text-negative"
              }`}
            >
              {formatPnl(pnl)}
            </p>
          </div>
        </div>

        {/* Current position block removed — full list shown in "Open positions" section below */}
      </CardContent>
    </Card>
  );
}
