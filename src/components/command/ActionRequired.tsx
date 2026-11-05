import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, PlugZap, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

type Priority = {
  tone: "danger" | "warn" | "ok";
  title: string;
  detail: string;
  cta?: { label: string; to: string };
};

/**
 * Single-priority action module. Derives one item from real backend state:
 * a broken exchange connection, an assigned strategy with no connection,
 * or a healthy "all clear" state. No fake alerts.
 */
export function ActionRequired() {
  const { user } = useAuth();

  const { data: connections } = useQuery({
    queryKey: ["action-required-connections", user?.id],
    enabled: !!user,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("exchange_connections")
        .select("id, exchange, status, last_error")
        .eq("user_id", user!.id);
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: active } = useQuery({
    queryKey: ["action-required-strategy", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_strategy")
        .select("strategy_id")
        .eq("user_id", user!.id)
        .order("symbol", { ascending: true })
          .limit(1).maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const priority = useMemo<Priority>(() => {
    const broken = (connections ?? []).find(
      (c) => c.status === "error" || c.status === "disconnected" || c.status === "needs_attention",
    );
    if (broken) {
      return {
        tone: "danger",
        title: `${broken.exchange.toUpperCase()} needs attention`,
        detail: broken.last_error ?? "Reconnect to resume execution.",
        cta: { label: "Fix", to: "/profile" },
      };
    }
    const hasConnection = (connections ?? []).length > 0;
    if (active?.strategy_id && !hasConnection) {
      return {
        tone: "warn",
        title: "Strategy assigned · no exchange connected",
        detail: "Connect an exchange to arm execution.",
        cta: { label: "Connect", to: "/wallet" },
      };
    }
    if (!active?.strategy_id) {
      return {
        tone: "warn",
        title: "No active turtle",
        detail: "Deploy a specialist from your squad to begin.",
        cta: { label: "Choose", to: "/squad" },
      };
    }
    return {
      tone: "ok",
      title: "All systems verified",
      detail: "Connection healthy · Awaiting engagement window.",
    };
  }, [connections, active]);

  const styles =
    priority.tone === "danger"
      ? {
          border: "color-mix(in oklab, var(--danger-red) 45%, transparent)",
          glow: "color-mix(in oklab, var(--danger-red) 22%, transparent)",
          color: "var(--danger-red)",
          Icon: AlertTriangle,
        }
      : priority.tone === "warn"
        ? {
            border: "color-mix(in oklab, var(--warn-amber) 45%, transparent)",
            glow: "color-mix(in oklab, var(--warn-amber) 18%, transparent)",
            color: "var(--warn-amber)",
            Icon: PlugZap,
          }
        : {
            border: "color-mix(in oklab, var(--verified) 40%, transparent)",
            glow: "color-mix(in oklab, var(--verified) 15%, transparent)",
            color: "var(--verified)",
            Icon: ShieldCheck,
          };

  const Icon = styles.Icon;

  return (
    <section className="mx-5 mt-4">
      <div
        className="relative flex items-center gap-3 overflow-hidden rounded-[16px] border bg-[color:var(--bg-elevated)] px-4 py-3 backdrop-blur-xl"
        style={{
          borderColor: styles.border,
          boxShadow: `0 0 0 1px ${styles.glow} inset, 0 18px 40px -28px ${styles.glow}`,
        }}
      >
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-[3px]"
          style={{ background: styles.color }}
        />
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          style={{ background: `color-mix(in oklab, ${styles.color} 15%, transparent)` }}
        >
          <Icon className="h-4 w-4" style={{ color: styles.color }} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-display text-[9.5px] font-bold uppercase tracking-[0.22em] text-[color:var(--text-secondary)]">
            Action Required
          </p>
          <p className="mt-0.5 truncate text-[13px] font-semibold text-[color:var(--text-primary)]">
            {priority.title}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-[color:var(--text-secondary)]">
            {priority.detail}
          </p>
        </div>
        {priority.cta && (
          <Link
            to={priority.cta.to}
            className="shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition hover:brightness-110"
            style={{
              background: `color-mix(in oklab, ${styles.color} 18%, transparent)`,
              color: styles.color,
              border: `1px solid color-mix(in oklab, ${styles.color} 40%, transparent)`,
            }}
          >
            {priority.cta.label}
          </Link>
        )}
      </div>
    </section>
  );
}
