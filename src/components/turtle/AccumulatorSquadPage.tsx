import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ArrowUp,
  ArrowDown,
  Lock,
  Target,
  Activity,
  Sparkles,
  AlertTriangle,
  CircleDashed,
  TrendingUp,
  TrendingDown,
  CheckCircle2,
  Home,
  Car,
  Gift,
  Palmtree,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Accordion, AccordionItem, AccordionContent } from "@/components/ui/accordion";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { TurtleAvatar } from "@/components/turtle/TurtleAvatar";
import { turtleImage } from "@/lib/turtles";

export { AccumulatorPage };


const WALLET_CAP = 500;

const LEVERAGE_TIERS = [
  { lev: 100, pct: 10,  maxUsd: 50.00 },
  { lev: 200, pct: 8,   maxUsd: 40.00 },
  { lev: 300, pct: 6,   maxUsd: 30.00 },
  { lev: 400, pct: 4,   maxUsd: 20.00 },
  { lev: 500, pct: 2.5, maxUsd: 12.50 },
] as const;

type BudgetItem = { id: string; label: string; defaultAmount: number };
type BudgetCategory = { key: string; name: string; emoji: string; icon: LucideIcon; items: BudgetItem[] };

const BUDGET_CATEGORIES: BudgetCategory[] = [
  {
    key: "roof", name: "The Roof", emoji: "🏠", icon: Home,
    items: [
      { id: "rent",      label: "Rent / Mortgage", defaultAmount: 1200 },
      { id: "light",     label: "Light Bill",      defaultAmount: 120 },
      { id: "water",     label: "Water Bill",      defaultAmount: 60 },
      { id: "internet",  label: "Internet",        defaultAmount: 70 },
      { id: "cell",      label: "Cell Phone",      defaultAmount: 80 },
      { id: "groceries", label: "Groceries",       defaultAmount: 400 },
    ],
  },
  {
    key: "ride", name: "The Ride", emoji: "🚗", icon: Car,
    items: [
      { id: "car_note",      label: "Car Note",      defaultAmount: 350 },
      { id: "car_insurance", label: "Car Insurance", defaultAmount: 140 },
      { id: "fuel",          label: "Fuel / Gas",    defaultAmount: 180 },
      { id: "maintenance",   label: "Maintenance",   defaultAmount: 60 },
    ],
  },
  {
    key: "memories", name: "The Memories", emoji: "🎁", icon: Gift,
    items: [
      { id: "birthday",    label: "Birthday",     defaultAmount: 150 },
      { id: "anniversary", label: "Anniversary",  defaultAmount: 200 },
      { id: "wedding",     label: "Wedding Gift", defaultAmount: 250 },
    ],
  },
  {
    key: "escape", name: "The Escape", emoji: "🏖️", icon: Palmtree,
    items: [
      { id: "flights", label: "Flights",    defaultAmount: 500 },
      { id: "hotel",   label: "Hotel / Stay", defaultAmount: 600 },
    ],
  },
];

type BudgetState = Record<string, { enabled: boolean; amount: number }>;

function Donut({
  pct,
  size = 28,
  stroke = 5,
  showLabel = false,
}: {
  pct: number;
  size?: number;
  stroke?: number;
  showLabel?: boolean;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const dash = (clamped / 100) * c;
  const color = "hsl(142 76% 36%)";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(217 33% 18%)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeDasharray={`${dash} ${c - dash}`}
        strokeDashoffset={c / 4}
        strokeLinecap="round"
        style={{ transition: "stroke-dasharray 600ms ease" }}
      />
      {showLabel && (
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          style={{
            fontSize: size * 0.14,
            fontWeight: 700,
            fill: "#39ff14",
          }}
        >
          {Math.round(clamped)}% FUNDED
        </text>
      )}
    </svg>
  );
}

type MarketCtx = "buy" | "sell" | "neutral";
type CycleStep = 1 | 2 | 3;

function tierFor(lev: number) {
  return LEVERAGE_TIERS.find((t) => t.lev === lev) ?? LEVERAGE_TIERS[0];
}

function AccumulatorPage() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: profile } = useQuery({
    queryKey: ["profile", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("*").eq("id", user!.id).maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  // Local UI state hydrated from profile
  const [mode, setMode] = useState<"long" | "short">("long");
  const [lev, setLev] = useState<number>(100);
  const [allocUsd, setAllocUsd] = useState<number>(50);
  const [walletUsd, setWalletUsd] = useState<number>(500);
  const [harvested, setHarvested] = useState<number>(0);
  const [budget, setBudget] = useState<BudgetState>(() => {
    const init: BudgetState = {};
    for (const cat of BUDGET_CATEGORIES)
      for (const it of cat.items) init[it.id] = { enabled: false, amount: it.defaultAmount };
    return init;
  });

  // Simulation state
  const [step, setStep] = useState<CycleStep>(1);
  const [breakevenReady, setBreakevenReady] = useState(false);
  const [ctx, setCtx] = useState<MarketCtx>("neutral");
  const [harvestOpen, setHarvestOpen] = useState(false);
  const [harvestAmount, setHarvestAmount] = useState(0);
  const [drillCat, setDrillCat] = useState<string | null>(null);

  useEffect(() => {
    if (!profile) return;
    setMode((profile.strategy_mode ?? "long") as "long" | "short");
    const t = tierFor(profile.current_leverage_tier ?? 100);
    setLev(t.lev);
    setAllocUsd(t.maxUsd);
    setWalletUsd(Number(profile.active_wallet_usd ?? 500));
    setHarvested(Number(profile.lifetime_harvested_cash ?? 0));
    const stored = (profile as { target_budget_items?: unknown }).target_budget_items;
    if (stored && typeof stored === "object") {
      setBudget((prev) => {
        const next = { ...prev };
        for (const [id, val] of Object.entries(stored as Record<string, { enabled?: boolean; amount?: number }>)) {
          if (next[id]) {
            next[id] = {
              enabled: !!val?.enabled,
              amount: typeof val?.amount === "number" ? val.amount : next[id].amount,
            };
          }
        }
        return next;
      });
    }
  }, [profile]);

  const tier = tierFor(lev);
  const cappedAlloc = Math.min(allocUsd, tier.maxUsd);

  // Ordered list of enabled items (funding order matches category & item order)
  const enabledItems = useMemo(() => {
    const list: { id: string; label: string; amount: number; emoji: string; category: string }[] = [];
    for (const cat of BUDGET_CATEGORIES)
      for (const it of cat.items) {
        const b = budget[it.id];
        if (b?.enabled && b.amount > 0)
          list.push({ id: it.id, label: it.label, amount: b.amount, emoji: cat.emoji, category: cat.name });
      }
    return list;
  }, [budget]);

  const totalBudget = useMemo(
    () => enabledItems.reduce((sum, it) => sum + it.amount, 0),
    [enabledItems],
  );
  const cyclesNeeded = totalBudget > 0 ? totalBudget / WALLET_CAP : 0;

  // Walk the funding pool across items in order
  const funding = useMemo(() => {
    let remaining = harvested;
    return enabledItems.map((it) => {
      const applied = Math.min(remaining, it.amount);
      remaining -= applied;
      return { ...it, applied, paid: applied >= it.amount, pct: it.amount ? (applied / it.amount) * 100 : 0 };
    });
  }, [enabledItems, harvested]);

  // Per-category funding aggregation by category key
  const categoryFunding = useMemo(() => {
    const map: Record<string, { funded: number; total: number; items: typeof funding }> = {};
    for (const cat of BUDGET_CATEGORIES) map[cat.key] = { funded: 0, total: 0, items: [] };
    for (const cat of BUDGET_CATEGORIES) {
      const ids = new Set(cat.items.map((i) => i.id));
      for (const f of funding) {
        if (ids.has(f.id)) {
          map[cat.key].funded += f.applied;
          map[cat.key].total += f.amount;
          map[cat.key].items.push(f);
        }
      }
    }
    return map;
  }, [funding]);

  // Rotate market context for the demo stream
  useEffect(() => {
    const id = setInterval(() => {
      const r = Math.random();
      setCtx(r < 0.4 ? "buy" : r < 0.75 ? "neutral" : "sell");
    }, 4200);
    return () => clearInterval(id);
  }, []);

  type ProfileUpdate = Partial<{
    strategy_mode: "long" | "short";
    current_leverage_tier: number;
    active_wallet_usd: number;
    lifetime_harvested_cash: number;
    target_budget_items: BudgetState;
  }>;
  async function persist(patch: ProfileUpdate) {
    if (!user) return;
    const { error } = await supabase.from("profiles").update(patch as never).eq("id", user.id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["profile", user.id] });
  }

  function pickLeverage(next: number) {
    const t = tierFor(next);
    setLev(t.lev);
    setAllocUsd(t.maxUsd);
    persist({ current_leverage_tier: t.lev });
    toast.success(`Leverage ${t.lev}x · allocation capped at $${t.maxUsd.toFixed(2)}`);
  }

  function toggleMode(next: "long" | "short") {
    setMode(next);
    persist({ strategy_mode: next });
  }

  function updateBudget(id: string, patch: Partial<{ enabled: boolean; amount: number }>) {
    setBudget((prev) => {
      const next = { ...prev, [id]: { ...prev[id], ...patch } };
      persist({ target_budget_items: next });
      return next;
    });
  }

  function advanceStep() {
    const next = ((step % 3) + 1) as CycleStep;
    setStep(next);
    // Eligible for Entry 3 only after Step 2 reclaims breakeven
    setBreakevenReady(next === 2 ? true : false);
  }

  function simulateProfit() {
    const profit = 60 + Math.random() * 80; // $60–140
    const newWallet = walletUsd + profit;
    if (newWallet > WALLET_CAP) {
      const harvest = +(newWallet - WALLET_CAP).toFixed(2);
      setHarvestAmount(harvest);
      setWalletUsd(WALLET_CAP);
      const newHarvest = +(harvested + harvest).toFixed(2);
      setHarvested(newHarvest);
      persist({ active_wallet_usd: WALLET_CAP, lifetime_harvested_cash: newHarvest });
      setHarvestOpen(true);
    } else {
      setWalletUsd(+newWallet.toFixed(2));
      persist({ active_wallet_usd: +newWallet.toFixed(2) });
    }
  }

  return (
    <div className="mx-auto min-h-screen max-w-md pb-28">
      <div className="px-5 pt-6">
        <h1 className="mt-2 font-display text-[22px] font-semibold tracking-tight">The Arbiter</h1>
        <p className="mt-1 text-[12.5px] text-muted-foreground">Safety-order DCA engine — tune your entries.</p>
      </div>

      {/* Hero */}
      <section className="mx-5 mt-2 flex items-center gap-4 rounded-[28px] border border-white/10 bg-gradient-to-br from-primary/12 via-white/[0.04] to-transparent p-5 shadow-[0_24px_60px_-30px_rgba(45,212,168,0.45)]">
        <TurtleAvatar src={turtleImage("dca")} ringColor="#22c55e" size={72} glow />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold">Safety-Order DCA Engine</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            3-step entries, breakeven recovery, hard $500 wallet cap.
          </p>
          <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-inset px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Lock className="h-3 w-3" /> Wallet cap ${WALLET_CAP}
          </div>
        </div>
      </section>

      {/* 1. Mode + Leverage */}
      <section className="mx-5 mt-4 rounded-2xl border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Direction</h2>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Master toggle</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            onClick={() => toggleMode("long")}
            className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-3 text-sm font-semibold transition ${
              mode === "long" ? "border-transparent bg-positive/15 text-positive ring-2 ring-positive/60" : "border-border text-muted-foreground hover:bg-inset"
            }`}
          >
            <ArrowUp className="h-4 w-4" /> LONG MODE
          </button>
          <button
            onClick={() => toggleMode("short")}
            className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-3 text-sm font-semibold transition ${
              mode === "short" ? "border-transparent bg-negative/15 text-negative ring-2 ring-negative/60" : "border-border text-muted-foreground hover:bg-inset"
            }`}
          >
            <ArrowDown className="h-4 w-4" /> SHORT MODE
          </button>
        </div>

        <div className="mt-5 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Leverage</h2>
          <span className="num text-sm font-semibold">{lev}x</span>
        </div>
        <div className="mt-3">
          <Slider
            value={[lev]}
            min={100}
            max={500}
            step={100}
            onValueChange={(v) => pickLeverage(v[0])}
          />
          <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
            {LEVERAGE_TIERS.map((t) => (
              <span key={t.lev} className={t.lev === lev ? "font-semibold text-foreground" : ""}>{t.lev}x</span>
            ))}
          </div>
        </div>

        {/* Risk matrix */}
        <div className="mt-4 overflow-hidden rounded-xl border border-border">
          <div className="grid grid-cols-3 bg-inset px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            <span>Leverage</span><span>Max %</span><span className="text-right">Max $ / trade</span>
          </div>
          {LEVERAGE_TIERS.map((t) => {
            const active = t.lev === lev;
            return (
              <div
                key={t.lev}
                className={`grid grid-cols-3 px-3 py-2 text-xs ${active ? "bg-positive/10 text-foreground" : "text-muted-foreground"}`}
              >
                <span className="num font-semibold">{t.lev}x</span>
                <span className="num">{t.pct}%</span>
                <span className="num text-right">${t.maxUsd.toFixed(2)}</span>
              </div>
            );
          })}
        </div>

        {/* Allocation input — hard capped */}
        <div className="mt-4">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Allocation per trade</span>
            <span className="num font-semibold">${cappedAlloc.toFixed(2)} <span className="text-muted-foreground">/ ${tier.maxUsd.toFixed(2)} max</span></span>
          </div>
          <Slider
            className="mt-3"
            value={[cappedAlloc]}
            min={10}
            max={tier.maxUsd}
            step={0.5}
            onValueChange={(v) => setAllocUsd(Math.min(v[0], tier.maxUsd))}
          />
          <p className="mt-2 text-[11px] text-muted-foreground">
            Capped automatically by the Risk-to-Leverage matrix. Wallet hard limit ${WALLET_CAP}.
          </p>
        </div>
      </section>

      {/* 1b. Directional Metrics — flips with mode */}
      {(() => {
        const isShort = mode === "short";
        const accent = isShort ? "negative" : "positive";
        const slipLabel = isShort
          ? "Dynamic Strategic Slip Area"
          : "Dynamic Strategic Slip Area";
        const slipSub = isShort
          ? "Monitors price increases (rises against the Short)"
          : "Monitors price decreases (drops against the Long)";
        const tpLabel = "Take Profit Targets";
        const tpSub = isShort
          ? "Monitors price decreases (drops in favor of the Short)"
          : "Monitors price increases (rises in favor of the Long)";
        return (
          <section
            className={`mx-5 mt-4 rounded-2xl border p-4 ${
              isShort
                ? "border-negative/40 bg-[hsl(0_70%_45%/0.08)]"
                : "border-positive/30 bg-positive/5"
            }`}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">
                Directional Metrics
              </h2>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                  isShort
                    ? "bg-negative/20 text-negative"
                    : "bg-positive/20 text-positive"
                }`}
              >
                {isShort ? "Short" : "Long"} Active
              </span>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2">
              <div className={`rounded-xl border border-${accent}/30 bg-inset p-3`}>
                <div className="flex items-center gap-2">
                  {isShort ? (
                    <TrendingUp className="h-4 w-4 text-negative" />
                  ) : (
                    <TrendingDown className="h-4 w-4 text-amber-400" />
                  )}
                  <p className="text-xs font-semibold">{slipLabel}</p>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">{slipSub}</p>
                <p className={`num mt-2 text-lg font-semibold ${isShort ? "text-negative" : "text-amber-400"}`}>
                  {isShort ? "+" : "−"}
                  {(1.2 + Math.random() * 0.4).toFixed(2)}% drift
                </p>
              </div>
              <div className={`rounded-xl border border-${accent}/30 bg-inset p-3`}>
                <div className="flex items-center gap-2">
                  {isShort ? (
                    <TrendingDown className="h-4 w-4 text-negative" />
                  ) : (
                    <TrendingUp className="h-4 w-4 text-positive" />
                  )}
                  <p className="text-xs font-semibold">{tpLabel}</p>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">{tpSub}</p>
                <p className={`num mt-2 text-lg font-semibold ${isShort ? "text-negative" : "text-positive"}`}>
                  {isShort ? "−" : "+"}
                  {(0.8 + Math.random() * 0.6).toFixed(2)}% target
                </p>
              </div>
            </div>
          </section>
        );
      })()}

      {/* 2. Itemized Lifestyle Budget */}
      <section className="mx-5 mt-4 rounded-2xl border border-border bg-surface p-4">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">Itemized Lifestyle Budget</h2>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Check the bills you want the bot to cover. Profits stream in, in order.
        </p>

        {/* Live total + cycles */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-primary/40 bg-primary/10 p-3">
            <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground">Monthly budget target</h2>
            <p className="num mt-1 text-2xl font-semibold text-primary">${totalBudget.toLocaleString()}</p>
          </div>
          <div className="rounded-xl border border-border bg-inset p-3">
            <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground">Harvest sweeps required</h2>
            <p className="num mt-1 text-2xl font-semibold">
              {cyclesNeeded > 0 ? `${cyclesNeeded.toFixed(1)}×` : "—"}
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {cyclesNeeded > 0 ? `at $${WALLET_CAP} per cycle` : "Select items below"}
            </p>
          </div>
        </div>

        {/* Accordion of categories */}
        <Accordion type="multiple" className="mt-3 space-y-2">
          {BUDGET_CATEGORIES.map((cat) => {
            const catItems = cat.items.map((it) => ({ it, b: budget[it.id] }));
            const catTotal = catItems.reduce((s, { b }) => s + (b?.enabled ? b.amount : 0), 0);
            const checkedCount = catItems.filter(({ b }) => b?.enabled).length;
            const cf = categoryFunding[cat.key];
            const catPct = cf && cf.total > 0 ? (cf.funded / cf.total) * 100 : 0;
            const Icon = cat.icon;
            return (
              <AccordionItem key={cat.key} value={cat.key} className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-xl">
                <AccordionPrimitive.Header className="flex flex-col">
                  <AccordionPrimitive.Trigger className="group flex w-full items-center gap-3 px-3.5 pt-3.5 pb-2.5 text-sm font-medium cursor-pointer text-left">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 ring-1 ring-primary/40 text-primary">
                      <Icon className="h-4 w-4" strokeWidth={2.25} />
                    </span>
                    <span className="text-[15px] font-semibold tracking-tight">{cat.name}</span>
                    <span className="ml-auto num text-xs text-muted-foreground">
                      {checkedCount > 0 ? `$${catTotal.toLocaleString()}` : `${cat.items.length} items`}
                    </span>
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
                  </AccordionPrimitive.Trigger>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`${cat.name} funding overview`}
                    onClick={() => setDrillCat(cat.key)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setDrillCat(cat.key);
                      }
                    }}
                    className="px-3.5 pb-3 cursor-pointer"
                    title={`${Math.round(catPct)}% funded — open overview`}
                  >
                    <Progress value={Math.min(100, catPct)} className="h-1.5" />
                  </div>
                </AccordionPrimitive.Header>
                <AccordionContent className="px-3">
                  <ul className="space-y-2">
                    {catItems.map(({ it, b }) => (
                      <li key={it.id} className="flex items-center gap-3 rounded-lg bg-inset px-2.5 py-2">
                        <Checkbox
                          checked={!!b?.enabled}
                          onCheckedChange={(v) => updateBudget(it.id, { enabled: !!v })}
                          aria-label={it.label}
                        />
                        <span className={`flex-1 text-xs ${b?.enabled ? "text-foreground" : "text-muted-foreground"}`}>
                          {it.label}
                        </span>
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-muted-foreground">$</span>
                          <Input
                            type="number"
                            inputMode="decimal"
                            min={0}
                            value={b?.amount ?? 0}
                            onChange={(e) =>
                              updateBudget(it.id, { amount: Math.max(0, Number(e.target.value) || 0) })
                            }
                            className="num h-8 w-24 px-2 text-right text-xs"
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      </section>





      {/* 3. Real-time deal visualizer */}
      <section className="mx-5 mt-4 rounded-2xl border border-border bg-surface p-4">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">Deal State</h2>
        </div>

        {/* Cycle steps */}
        <div className="mt-3 flex items-center gap-2">
          {[1, 2, 3].map((n) => {
            const reached = step >= n;
            return (
              <div key={n} className="flex flex-1 items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold ${
                    reached ? "bg-positive text-[#04342C]" : "bg-inset text-muted-foreground"
                  }`}
                >
                  {n}
                </div>
                {n < 3 && <div className={`h-0.5 flex-1 ${step > n ? "bg-positive" : "bg-inset"}`} />}
              </div>
            );
          })}
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>Initial Entry</span>
          <span className="text-center">Safety Buy</span>
          <span className="text-right">Recovery</span>
        </div>

        {/* ATR-band simulated chart */}
        {(() => {
          const isShort = mode === "short";
          const W = 320, H = 110, P = 8;
          // Sample price path (0..1 normalized)
          const pts = [0.50, 0.55, 0.48, 0.62, 0.58, 0.70, 0.66, 0.78, 0.74, 0.85, 0.80, 0.92];
          // In LONG mode, invert so it dips to the lower band; in SHORT keep upward spikes
          const series = isShort ? pts : pts.map((v) => 1 - v);
          const upper = 0.85, lower = 0.15, mid = 0.5;
          const toX = (i: number) => P + (i * (W - 2 * P)) / (series.length - 1);
          const toY = (v: number) => P + (1 - v) * (H - 2 * P);
          const path = series.map((v, i) => `${i === 0 ? "M" : "L"}${toX(i)},${toY(v)}`).join(" ");
          // Trigger: in SHORT when price >= upper band; in LONG when (inverted) price <= lower
          const triggers = series
            .map((v, i) => ({ v, i }))
            .filter(({ v }) => (isShort ? v >= upper : v <= lower));
          const stroke = isShort ? "var(--negative, #ef4444)" : "var(--positive, #22c55e)";
          const bandFill = isShort ? "hsl(0 70% 50% / 0.08)" : "hsl(150 60% 45% / 0.08)";
          return (
            <div className={`mt-4 overflow-hidden rounded-xl border p-3 ${isShort ? "border-negative/40 bg-[hsl(0_70%_45%/0.06)]" : "border-positive/30 bg-positive/5"}`}>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Execution Feed · ATR Bands
                </h2>
                <p className={`text-[10px] font-bold uppercase tracking-wider ${isShort ? "text-negative" : "text-positive"}`}>
                  {isShort ? "Short Triggers ↑" : "Long Triggers ↓"}
                </p>
              </div>
              <svg viewBox={`0 0 ${W} ${H}`} className="h-28 w-full">
                <rect x={P} y={toY(upper)} width={W - 2 * P} height={toY(lower) - toY(upper)} fill={bandFill} />
                <line x1={P} y1={toY(upper)} x2={W - P} y2={toY(upper)} stroke="hsl(0 0% 50% / 0.4)" strokeDasharray="3 3" />
                <line x1={P} y1={toY(mid)}   x2={W - P} y2={toY(mid)}   stroke="hsl(0 0% 50% / 0.25)" strokeDasharray="2 4" />
                <line x1={P} y1={toY(lower)} x2={W - P} y2={toY(lower)} stroke="hsl(0 0% 50% / 0.4)" strokeDasharray="3 3" />
                <path d={path} fill="none" stroke={stroke} strokeWidth="2" />
                {triggers.map(({ v, i }) => (
                  <g key={i}>
                    <circle cx={toX(i)} cy={toY(v)} r="4.5" fill={stroke} />
                    <circle cx={toX(i)} cy={toY(v)} r="9" fill={stroke} opacity="0.18" />
                  </g>
                ))}
              </svg>
              <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                <span>Upper ATR</span><span>Mid</span><span>Lower ATR</span>
              </div>
            </div>
          );
        })()}

        {/* Breakeven light + market ctx */}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <div
            className={`rounded-xl border p-3 ${
              breakevenReady
                ? mode === "short"
                  ? "border-negative/60 bg-negative/10"
                  : "border-positive/60 bg-positive/10"
                : "border-border bg-inset"
            }`}
          >
            <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Breakeven Light {mode === "short" ? "· monitoring ↓" : "· monitoring ↑"}
            </h2>
            <div className="mt-1 flex items-center gap-2">
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  breakevenReady
                    ? mode === "short"
                      ? "bg-positive shadow-[0_0_12px_var(--positive)]"
                      : "bg-positive shadow-[0_0_12px_var(--positive)]"
                    : "bg-amber-400"
                }`}
              />
              <span className="text-xs font-semibold">
                {breakevenReady
                  ? "ELIGIBLE FOR ENTRY 3"
                  : mode === "short"
                    ? "Waiting for downside breakeven"
                    : "Waiting for breakeven"}
              </span>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-inset p-3">
            <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground">Market Context</h2>
            <div className="mt-1 flex items-center gap-2">
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  ctx === "buy" ? "bg-positive" : ctx === "sell" ? "bg-negative" : "bg-text-muted"
                }`}
              />
              <span className="text-xs font-semibold uppercase tracking-wider">
                {ctx === "buy" ? "Strong Buy" : ctx === "sell" ? "Strong Sell" : "Neutral"}
              </span>
            </div>
          </div>
        </div>

        {/* Wallet + sim controls */}
        <div className="mt-4 rounded-xl border border-border bg-inset p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Active wallet</span>
            <span className="num font-semibold">${walletUsd.toFixed(2)} / ${WALLET_CAP}</span>
          </div>
          <Progress value={(walletUsd / WALLET_CAP) * 100} className="mt-2" />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            onClick={advanceStep}
            className="rounded-xl border border-border bg-inset px-3 py-2.5 text-xs font-semibold hover:bg-surface"
          >
            Advance cycle step
          </button>
          <button
            onClick={simulateProfit}
            className="rounded-xl bg-primary px-3 py-2.5 text-xs font-semibold text-[#04342C] hover:opacity-90"
          >
            <Sparkles className="mr-1 inline h-3.5 w-3.5" /> Simulate profit
          </button>
        </div>
      </section>

      {/* Harvest modal */}
      <Dialog open={harvestOpen} onOpenChange={setHarvestOpen}>
        <DialogContent className="border-positive/40">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-positive">
              <AlertTriangle className="h-5 w-5" /> Anti-Greed Harvest
            </DialogTitle>
            <DialogDescription className="pt-2 text-foreground">
              Wallet exceeded the ${WALLET_CAP} safety baseline.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-xl border border-positive/40 bg-positive/10 p-4">
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground">Harvested cash</h2>
            <p className="num mt-1 text-3xl font-semibold text-positive">+${harvestAmount.toFixed(2)}</p>
            <p className="mt-3 text-xs text-muted-foreground">
              Withdrawal Complete — Resetting Account to ${WALLET_CAP} Safety Baseline.
            </p>
          </div>
          <DialogFooter>
            <button
              onClick={() => setHarvestOpen(false)}
              className="w-full rounded-xl bg-primary py-2.5 text-sm font-semibold text-[#04342C]"
            >
              Confirm withdrawal
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Category drill-down modal */}
      <Dialog open={!!drillCat} onOpenChange={(o) => !o && setDrillCat(null)}>
        <DialogContent className="max-w-sm">
          {(() => {
            const cat = BUDGET_CATEGORIES.find((c) => c.key === drillCat);
            if (!cat) return null;
            const cf = categoryFunding[cat.key];
            const pct = cf.total > 0 ? (cf.funded / cf.total) * 100 : 0;
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <span className="text-xl leading-none">{cat.emoji}</span>
                    {cat.name} Overview
                  </DialogTitle>
                  <DialogDescription>
                    ${cf.funded.toFixed(0)} of ${cf.total.toLocaleString()} funded from the harvest pool.
                  </DialogDescription>
                </DialogHeader>

                <div className="flex justify-center py-2">
                  <Donut pct={pct} size={180} stroke={18} showLabel />
                </div>

                {cf.items.length === 0 ? (
                  <p className="text-center text-xs text-muted-foreground">
                    No items enabled in this category yet.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {cf.items.map((f) => (
                      <li
                        key={f.id}
                        className={`flex items-center justify-between gap-2 rounded-lg border p-2.5 ${
                          f.paid ? "border-positive/40 bg-positive/5" : "border-border bg-inset"
                        }`}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          {f.paid ? (
                            <CheckCircle2 className="h-4 w-4 shrink-0 text-positive" />
                          ) : (
                            <CircleDashed className="h-4 w-4 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate text-xs font-medium">{f.label}</span>
                        </div>
                        <span className="num shrink-0 text-[11px] text-muted-foreground">
                          ${f.applied.toFixed(0)} / ${f.amount.toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      
    </div>
  );
}
