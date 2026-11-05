import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Home, Car } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { normalizeBuckets } from "@/lib/strategy-config";

/**
 * The two essential Life Map sectors: Roof + Ride. Reads real
 * target_budget_items from public.profiles. Zero fake numbers.
 */
export function ProtectYourWorld() {
  const { user } = useAuth();

  const { data: profile } = useQuery({
    queryKey: ["profile-protect", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("target_budget_items")
        .eq("id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const sectors = useMemo(() => {
    const b = normalizeBuckets(profile?.target_budget_items);
    return [
      { key: "roof", label: "Roof", Icon: Home, accent: "var(--intel-cyan)", state: b.roof },
      { key: "ride", label: "Ride", Icon: Car, accent: "var(--brand-violet)", state: b.ride },
    ] as const;
  }, [profile]);

  return (
    <section className="mx-5 mt-4">
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2 className="font-display text-[11px] font-bold uppercase tracking-[0.24em] text-[color:var(--text-secondary)]">
          Protect Your World
        </h2>
        <span className="font-display text-[10px] font-medium uppercase tracking-[0.18em] text-[color:var(--text-secondary)]">
          Essentials
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {sectors.map(({ key, label, Icon, accent, state }) => {
          const target = state.target || 0;
          const current = state.current || 0;
          const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
          return (
            <div
              key={key}
              className="command-surface relative overflow-hidden p-3"
              style={{
                boxShadow: `0 0 0 1px color-mix(in oklab, ${accent} 20%, transparent) inset, 0 18px 40px -28px color-mix(in oklab, ${accent} 40%, transparent)`,
              }}
            >
              <div
                aria-hidden
                className="pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-full opacity-40 blur-2xl"
                style={{ background: accent }}
              />
              <div className="flex items-center gap-2">
                <div
                  className="flex h-7 w-7 items-center justify-center rounded-md"
                  style={{ background: `color-mix(in oklab, ${accent} 15%, transparent)` }}
                >
                  <Icon className="h-3.5 w-3.5" style={{ color: accent }} />
                </div>
                <span className="font-display text-[13px] font-semibold uppercase tracking-[0.06em]">
                  {label}
                </span>
              </div>

              <div className="mt-3 flex items-baseline justify-between">
                <span className="num font-display text-[18px] font-semibold leading-none">
                  {pct}%
                </span>
                <span className="num text-[10px] text-[color:var(--text-secondary)]">
                  {target > 0 ? `$${current.toLocaleString()}/$${target.toLocaleString()}` : "—"}
                </span>
              </div>

              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${pct}%`,
                    background: accent,
                    boxShadow:
                      target > 0
                        ? `0 0 8px color-mix(in oklab, ${accent} 60%, transparent)`
                        : "none",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
