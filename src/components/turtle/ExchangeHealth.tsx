import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Plug } from "lucide-react";
import { Link } from "@tanstack/react-router";

type Conn = {
  id: string;
  exchange: string;
  status: "connected" | "error" | "disconnected" | null;
};

const STATUS_TINT: Record<string, string> = {
  connected:   "bg-positive shadow-[0_0_8px_rgba(115,255,184,0.7)]",
  error:       "bg-negative shadow-[0_0_8px_rgba(255,120,120,0.6)]",
  disconnected:"bg-muted-foreground/60",
};

/**
 * Inline exchange health pill in the header.
 * Tap goes straight to /profile to manage exchanges — no popover, no dropdown.
 */
export function ExchangeHealth() {
  const { user } = useAuth();

  const { data } = useQuery({
    queryKey: ["exchange-health", user?.id],
    enabled: !!user,
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("exchange_connections")
        .select("id, exchange, status")
        .eq("user_id", user!.id)
        .order("exchange", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Conn[];
    },
  });

  // Defensive: never let a non-array cache shape crash the header — a throw
  // here bubbles to the route error boundary and unmounts any open sheet,
  // wiping in-progress API-key input.
  const conns: Conn[] = Array.isArray(data) ? data : [];
  const healthy = conns.filter((c) => c.status === "connected").length;
  const total = conns.length;

  return (
    <Link
      to="/profile"
      aria-label="Manage exchange connections"
      className="flex h-10 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 text-muted-foreground transition hover:text-foreground"
    >
      <Plug className="h-3.5 w-3.5" />
      {total > 0 ? (
        <>
          <div className="flex items-center gap-1">
            {conns.slice(0, 4).map((c) => (
              <span
                key={c.id}
                className={`h-2 w-2 rounded-full ${STATUS_TINT[c.status ?? "disconnected"]}`}
              />
            ))}
          </div>
          <span className="num text-[10.5px] font-semibold text-foreground/80">
            {healthy}/{total}
          </span>
        </>
      ) : (
        <span className="text-[10.5px] font-semibold">Connect</span>
      )}
    </Link>
  );
}
