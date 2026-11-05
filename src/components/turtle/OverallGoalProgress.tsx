import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { BUCKETS, normalizeBuckets } from "@/lib/strategy-config";

export function OverallGoalProgress() {
  const { user } = useAuth();

  const { data: profile } = useQuery({
    queryKey: ["profile-buckets", user?.id],
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

  const { current, target, pct } = useMemo(() => {
    const buckets = normalizeBuckets(profile?.target_budget_items);
    const c = BUCKETS.reduce((sum, b) => sum + (buckets[b.key].current || 0), 0);
    const t = BUCKETS.reduce((sum, b) => sum + (buckets[b.key].target || 0), 0);
    const p = t > 0 ? Math.min(100, Math.round((c / t) * 100)) : 0;
    return { current: c, target: t, pct: p };
  }, [profile]);

  return (
    <section className="mx-5 mt-6">
      <div className="rounded-[18px] border border-white/10 bg-white/[0.05] p-4 backdrop-blur-xl">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">
            Goal Progress
          </h2>
          <span className="num text-[12px] font-semibold">{pct}%</span>
        </div>

        <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-black/60">
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${pct}%`,
              background: "#14F195",
              boxShadow: target > 0 ? "0 0 12px rgba(20,241,149,0.5)" : "none",
            }}
          />
        </div>

        <p className="num mt-2 text-[12px] text-muted-foreground">
          {target > 0
            ? `$${current.toLocaleString()} / $${target.toLocaleString()} total saved`
            : "No goals set yet"}
        </p>
      </div>
    </section>
  );
}
