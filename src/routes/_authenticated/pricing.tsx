import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Check, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { PLANS, type PlanDef } from "@/lib/plans";
import type { SubscriptionTier } from "@/lib/subscription-tiers";

export const Route = createFileRoute("/_authenticated/pricing")({
  component: PricingPage,
  head: () => ({
    meta: [
      { title: "Pricing — Turtle Bot" },
      {
        name: "description",
        content:
          "Five Turtle Bot plans — Free, ION, ARC, ORB, ZEN. Paper testing is free. Live trading unlocks after our forward test proves out.",
      },
      { property: "og:title", content: "Pricing — Turtle Bot" },
      {
        property: "og:description",
        content:
          "Free paper lab, live trading tiers, and Life Mode auto-funding at ORB and above.",
      },
    ],
  }),
});

function PricingPage() {
  const { user, isReady } = useAuth();
  const [currentTier, setCurrentTier] = useState<SubscriptionTier>("free");

  useEffect(() => {
    if (!isReady || !user) return;
    let cancelled = false;
    void supabase
      .from("subscriptions")
      .select("tier")
      .eq("user_id", user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        if (data?.tier) setCurrentTier(data.tier as SubscriptionTier);
      });
    return () => {
      cancelled = true;
    };
  }, [isReady, user]);

  function onChoose(plan: PlanDef) {
    if (plan.key === currentTier) {
      toast("You're already on this plan");
      return;
    }
    if (plan.key === "free") {
      toast.success("Free is available to everyone — no checkout needed");
      return;
    }
    toast("Checkout is coming next", {
      description: `${plan.name} — $${plan.priceMonthly}/mo. We'll wire billing shortly.`,
    });
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="mx-auto w-full max-w-[1280px] px-5 py-10 lg:px-10 lg:py-14">
        {/* Eyebrow — mono ticker texture */}
        <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-[hsl(var(--data-cyan))]">
          TB · PLANS · v1
        </p>

        <div className="mt-3 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <h1 className="font-display text-[36px] font-semibold leading-[1.05] tracking-tight lg:text-[52px]">
              Pick the plan that matches how far you want to go.
            </h1>
            <p className="mt-3 text-[14px] leading-relaxed text-white/60">
              Paper testing is free forever — watch the edge work before you
              commit a dollar. Live trading, more wallets, more symbols, and
              Life Mode auto-funding unlock as you move up.
            </p>
          </div>

          <div className="rounded-2xl bg-white/[0.04] px-4 py-3 text-[12px] text-white/70 lg:min-w-[260px]">
            <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-white/40">
              Current plan
            </div>
            <div className="mt-1 font-display text-[20px] font-semibold text-white">
              {PLANS.find((p) => p.key === currentTier)?.name ?? "Free"}
            </div>
          </div>
        </div>

        {/* Honest live-trading banner */}
        <div className="mt-6 flex items-start gap-3 rounded-2xl border border-white/5 bg-white/[0.04] p-4">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--data-cyan))]" />
          <p className="text-[13px] leading-relaxed text-white/70">
            <span className="font-semibold text-white">
              Live trading unlocks once our forward test completes.
            </span>{" "}
            Paper testing and Life Map are available now. Plans and prices
            below are final — checkout wires up next.
          </p>
        </div>

        {/* Tier grid */}
        <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {PLANS.map((plan) => (
            <TierCard
              key={plan.key}
              plan={plan}
              current={plan.key === currentTier}
              onChoose={() => onChoose(plan)}
            />
          ))}
        </div>

        {/* Small comparison note */}
        <p className="mt-8 text-[12px] leading-relaxed text-white/50">
          Life Map is on every plan. It <em>deepens</em> at ORB and ZEN with
          auto-funding — bot gains flow toward your bills automatically. No
          plan removes Life Map.
        </p>
      </div>
    </div>
  );
}

function TierCard({
  plan,
  current,
  onChoose,
}: {
  plan: PlanDef;
  current: boolean;
  onChoose: () => void;
}) {
  const featured = plan.featured;
  return (
    <div
      className={cn(
        "relative flex flex-col rounded-2xl border border-white/5 bg-white/[0.04] p-6",
        featured && "border-[hsl(var(--data-cyan))]/40",
      )}
    >
      {featured && (
        <span className="absolute -top-2.5 left-6 rounded-full bg-[hsl(var(--data-cyan))]/15 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-[hsl(var(--data-cyan))]">
          Most popular
        </span>
      )}
      {current && (
        <span className="absolute -top-2.5 right-6 rounded-full bg-white/[0.08] px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-white/70">
          Current
        </span>
      )}

      <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-white/50">
        {plan.name}
      </p>
      <p className="mt-1 text-[13.5px] text-white/70">{plan.tagline}</p>

      <div className="mt-5 flex items-baseline gap-1">
        <span className="font-display text-[44px] font-semibold tabular-nums leading-none tracking-tight text-white">
          {plan.priceMonthly === 0 ? "$0" : `$${plan.priceMonthly}`}
        </span>
        <span className="text-[12px] font-medium uppercase tracking-wider text-white/45">
          /mo
        </span>
      </div>

      <div className="mt-4 rounded-xl bg-white/[0.03] p-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">
          Live wallets
        </p>
        <p className="mt-0.5 font-display text-[20px] font-semibold tabular-nums text-[hsl(var(--data-cyan))]">
          {plan.walletLimit === 0 ? "—" : plan.walletLimit}
          {plan.walletLimit > 0 && (
            <span className="ml-1 text-[11px] font-medium uppercase tracking-wider text-white/45">
              live
            </span>
          )}
        </p>
      </div>

      <ul className="mt-5 flex-1 space-y-2">
        {plan.features.map((f) => (
          <li key={f} className="flex items-start gap-2 text-[12.5px] leading-relaxed text-white/75">
            <Check className="mt-[3px] h-3.5 w-3.5 shrink-0 text-[hsl(var(--data-cyan))]" />
            <span>{f}</span>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={onChoose}
        className={cn(
          "mt-6 h-11 w-full rounded-xl text-[13.5px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#9945FF]/70",
          "bg-[#9945FF] text-white hover:bg-[#8a3df0] disabled:opacity-60",
        )}
        aria-label={`${plan.cta} — $${plan.priceMonthly} per month`}
      >
        {current ? "Current plan" : plan.cta}
      </button>
    </div>
  );
}
