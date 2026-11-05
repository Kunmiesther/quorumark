import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { BUCKETS, normalizeBuckets } from "@/lib/strategy-config";

/**
 * Radial "shield" gauge showing how much of the user's declared life obligations
 * are currently covered. Reads target_budget_items from public.profiles only —
 * no fake numbers, no invented positions.
 */
export function LifeStabilityInstrument() {
  const { user } = useAuth();

  const { data: profile } = useQuery({
    queryKey: ["profile-life-stability", user?.id],
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

  const { pct, current, target, next } = useMemo(() => {
    const buckets = normalizeBuckets(profile?.target_budget_items);
    const c = BUCKETS.reduce((s, b) => s + (buckets[b.key].current || 0), 0);
    const t = BUCKETS.reduce((s, b) => s + (buckets[b.key].target || 0), 0);
    const p = t > 0 ? Math.min(100, Math.round((c / t) * 100)) : 0;

    // Next obligation to fund = the bucket with the largest unfunded gap.
    let nextBucket: { label: string; gap: number } | null = null;
    for (const b of BUCKETS) {
      const state = buckets[b.key];
      const gap = (state.target || 0) - (state.current || 0);
      if (gap > 0 && (!nextBucket || gap > nextBucket.gap)) {
        nextBucket = { label: b.label, gap };
      }
    }
    return { pct: p, current: c, target: t, next: nextBucket };
  }, [profile]);

  // Radial ring math
  const size = 132;
  const stroke = 10;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (pct / 100) * circ;

  return (
    <section className="mx-5 mt-4">
      <div className="command-surface p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-display text-[11px] font-bold uppercase tracking-[0.24em] text-[color:var(--text-secondary)]">
            Life Stability
          </h2>
          <span className="num text-[11px] text-[color:var(--text-secondary)]">
            {target > 0 ? "Protected" : "Not calibrated"}
          </span>
        </div>

        <div className="flex items-center gap-5">
          <div className="relative shrink-0" style={{ width: size, height: size }}>
            <svg width={size} height={size} className="-rotate-90">
              <circle
                cx={size / 2}
                cy={size / 2}
                r={r}
                strokeWidth={stroke}
                stroke="rgba(255,255,255,0.06)"
                fill="none"
              />
              <circle
                cx={size / 2}
                cy={size / 2}
                r={r}
                strokeWidth={stroke}
                stroke="var(--verified)"
                strokeLinecap="round"
                strokeDasharray={circ}
                strokeDashoffset={offset}
                fill="none"
                style={{
                  filter:
                    target > 0
                      ? "drop-shadow(0 0 8px color-mix(in oklab, var(--verified) 60%, transparent))"
                      : "none",
                  transition: "stroke-dashoffset 600ms ease",
                }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="num font-display text-[28px] font-semibold leading-none text-[color:var(--text-primary)]">
                {pct}%
              </span>
              <span className="mt-1 font-display text-[9px] font-bold uppercase tracking-[0.24em] text-[color:var(--text-secondary)]">
                Shielded
              </span>
            </div>
          </div>

          <div className="min-w-0 flex-1 space-y-3">
            <Metric
              label="Covered"
              value={target > 0 ? `$${current.toLocaleString()}` : "—"}
            />
            <Metric
              label="Target"
              value={target > 0 ? `$${target.toLocaleString()}` : "Set in Life Map"}
            />
            <Metric
              label="Next"
              value={next ? `${next.label} · $${next.gap.toLocaleString()}` : "All targets met"}
              accent
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/[0.04] pb-2 last:border-0 last:pb-0">
      <span className="font-display text-[9.5px] font-bold uppercase tracking-[0.22em] text-[color:var(--text-secondary)]">
        {label}
      </span>
      <span
        className={`num truncate text-right text-[13px] font-semibold ${
          accent ? "text-[color:var(--intel-cyan)]" : "text-[color:var(--text-primary)]"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
