import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Plug, X } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

type AlertKind = "disconnect" | "error";

type AlertItem = {
  id: string;
  kind: AlertKind;
  title: string;
  detail: string;
  at: number;
};

function relTime(now: number, ts: number): string {
  const s = Math.max(1, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Inline alert strip — renders nothing when there are no real alerts.
 * No bell, no popover, no badge to click. Sits right under the header.
 */
export function AlertsCenter() {
  const { user } = useAuth();
  const [now, setNow] = useState(Date.now());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const { data: connections } = useQuery({
    queryKey: ["alerts-exchange-connections", user?.id],
    enabled: !!user,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("exchange_connections")
        .select("id, exchange, status, last_error, updated_at")
        .eq("user_id", user!.id);
      if (error) throw error;
      return data ?? [];
    },
  });

  const alerts = useMemo<AlertItem[]>(() => {
    const list: AlertItem[] = [];
    (connections ?? []).forEach((c) => {
      if (c.status === "error" || c.status === "disconnected") {
        const ts = c.updated_at ? new Date(c.updated_at).getTime() : now;
        const id = `conn-${c.id}`;
        if (dismissed.has(id)) return;
        list.push({
          id,
          kind: c.status === "error" ? "error" : "disconnect",
          title: `${c.exchange.toUpperCase()} ${c.status === "error" ? "error" : "disconnected"}`,
          detail: c.last_error ?? `Updated ${relTime(now, ts)}`,
          at: ts,
        });
      }
    });
    return list.sort((a, b) => b.at - a.at);
  }, [connections, now, dismissed]);

  if (alerts.length === 0) return null;

  return (
    <div className="mx-5 mt-1 mb-2 space-y-1.5">
      {alerts.slice(0, 2).map((a) => {
        const tone =
          a.kind === "error"
            ? "border-negative/30 bg-negative/[0.08] text-negative"
            : "border-gold/30 bg-gold/[0.08] text-gold";
        const Icon = a.kind === "error" ? AlertTriangle : Plug;
        return (
          <div
            key={a.id}
            className={`flex items-center gap-2.5 rounded-2xl border px-3 py-2 ${tone}`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-semibold text-foreground">{a.title}</p>
              <p className="truncate text-[10.5px] text-muted-foreground">{a.detail}</p>
            </div>
            <Link
              to="/profile"
              className="shrink-0 rounded-full bg-white/[0.06] px-2.5 py-1 text-[10.5px] font-semibold text-foreground hover:bg-white/[0.12]"
            >
              Fix
            </Link>
            <button
              onClick={() => setDismissed((s) => new Set(s).add(a.id))}
              aria-label="Dismiss alert"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 hover:bg-white/[0.05] hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
      {alerts.length > 2 && (
        <Link
          to="/profile"
          className="block px-1 text-[10.5px] font-medium text-muted-foreground hover:text-foreground"
        >
          +{alerts.length - 2} more alerts
        </Link>
      )}
    </div>
  );
}
