import { useEffect, useState } from "react";
import {
  Bed, Cake, Camera, Car, CarFront, Check, ChevronDown, Droplet, FileText, Gift,
  Heart, Home, Lightbulb, Loader2, Plane, Plus, Shield, Smartphone, Ticket, Trash2,
  TreePine, Wallet, Wifi, Wrench, type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { CAPITAL_RULES } from "@/lib/capital-rules";
import {
  BUCKETS,
  type BucketKey,
  type BudgetItem,
  STRATEGY_REQUIREMENTS,
  UNIFIED_LEVERAGE_STRATEGIES,
  clampLeverage,
  getItemsOrDefault,
  getLeverageRisk,
  normalizeBuckets,
} from "@/lib/strategy-config";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { LeverageSelector } from "@/components/turtle/LeverageSelector";

const ICON_MAP: Record<string, LucideIcon> = {
  home: Home, lightbulb: Lightbulb, droplet: Droplet, wifi: Wifi, smartphone: Smartphone,
  car: Car, wrench: Wrench, shield: Shield, "file-text": FileText,
  heart: Heart, cake: Cake, gift: Gift, "tree-pine": TreePine,
  bed: Bed, plane: Plane, "car-front": CarFront, ticket: Ticket,
  camera: Camera,
};

export interface StrategyConfigStrategy {
  id: string;
  slug: string;
  name: string;
  suit_name: string;
  description: string;
  markets: "spot" | "futures" | "both";
}

interface Props {
  strategy: StrategyConfigStrategy;
  initialBucket?: BucketKey;
  onClose: () => void;
  onSaved: () => void;
}

export function StrategyConfigModal({ strategy, initialBucket, onClose, onSaved }: Props) {
  const { user } = useAuth();
  const reqs = STRATEGY_REQUIREMENTS[strategy.slug];
  const isFutures = strategy.markets !== "spot";
  const isLeverageSelectable = isFutures && UNIFIED_LEVERAGE_STRATEGIES.has(strategy.slug);
  const max = CAPITAL_RULES.maxTradeCapital;

  const defaultLeverage = reqs?.leverage ?? 100;

  
  const [capital, setCapital] = useState("100");
  const [leverage, setLeverage] = useState(defaultLeverage);
  const [riskPct, setRiskPct] = useState(() => getLeverageRisk(defaultLeverage));
  const [positionSize, setPositionSize] = useState(() => Math.round(500 * (defaultLeverage / 100) * 100) / 100);
  const [bucket, setBucket] = useState<BucketKey>(initialBucket ?? "roof");
  const [expandedKey, setExpandedKey] = useState<BucketKey | null>(initialBucket ?? null);
  const [allBucketItems, setAllBucketItems] = useState<Record<BucketKey, BudgetItem[]>>({
    roof: [], ride: [], memories: [], escape: [],
  });
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [initialLoadedLeverage, setInitialLoadedLeverage] = useState<number | null>(null);

  const displayedStopLoss = isLeverageSelectable ? riskPct : (reqs?.stopLossPct ?? 5);

  // Load existing buckets, capital, and leverage once.
  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("target_budget_items, current_leverage_tier, active_wallet_usd")
        .eq("id", user.id)
        .maybeSingle();
      const norm = normalizeBuckets(data?.target_budget_items);
      setAllBucketItems({
        roof: getItemsOrDefault("roof", norm.roof.items),
        ride: getItemsOrDefault("ride", norm.ride.items),
        memories: getItemsOrDefault("memories", norm.memories.items),
        escape: getItemsOrDefault("escape", norm.escape.items),
      });
      // Any finite saved value is honoured, clamped to the selectable range.
      // Membership of the old preset table is no longer the test — that
      // rejected every value between the presets and silently reset it to the
      // default, which is how a deliberate 60x became 100x on reload.
      const savedRaw = Number(data?.current_leverage_tier);
      const effLeverage = Number.isFinite(savedRaw) && savedRaw > 0
        ? clampLeverage(savedRaw)
        : clampLeverage(defaultLeverage);
      setLeverage(effLeverage);
      setRiskPct(getLeverageRisk(effLeverage));
      setInitialLoadedLeverage(effLeverage);
      if (data?.active_wallet_usd && Number(data.active_wallet_usd) > 0) {
        setCapital(String(data.active_wallet_usd));
      }
      setLoaded(true);
    })();
  }, [user, defaultLeverage]);

  const goalLabel = reqs?.goalLabel ?? "—";

  function updateItem(key: BucketKey, idx: number, patch: Partial<BudgetItem>) {
    setAllBucketItems((prev) => {
      const next = { ...prev };
      const arr = [...next[key]];
      arr[idx] = { ...arr[idx], ...patch };
      next[key] = arr;
      return next;
    });
  }

  function removeItem(key: BucketKey, idx: number) {
    setAllBucketItems((prev) => {
      const next = { ...prev };
      next[key] = next[key].filter((_, i) => i !== idx);
      return next;
    });
  }

  function addItem(key: BucketKey) {
    setAllBucketItems((prev) => {
      const next = { ...prev };
      next[key] = [
        ...next[key],
        { id: `custom-${Date.now()}`, icon: "•", label: "New item", amount: 0 },
      ];
      return next;
    });
  }

  async function submit() {
    if (!user) return;
    const cap = Number(capital);
    if (!Number.isFinite(cap) || cap <= 0) return toast.error("Enter valid capital");
    if (cap > max) toast(`Capital capped at $${max}`);
    const clamped = Math.min(cap, max);

    // Persist the customer's ACTUAL choice, clamped only to what the venue
    // and the ratified ceiling allow (1..100).
    //
    // This used to snap to the nearest LEVERAGE_RISK_MAP key — [50, 100, 200,
    // 300, 400, 500] — so a customer choosing 60x had 50x saved, and anyone
    // choosing above 100x had an unreachable number saved that the worker and
    // signer then clamped back to 100 anyway.
    const chosenLeverage = clampLeverage(leverage);

    // What the SCREEN promises, which is not always the slider.
    //
    // Unified strategies show the slider, so the slider is the promise. A
    // non-unified futures strategy shows a fixed `Leverage: Nx` requirement
    // row instead — and until now the bot ignored it and used the pilot
    // ceiling, so a strategy displaying 10x actually traded at 100x. Ten
    // times the stated leverage, in the direction nobody checks.
    //
    // Persisting the displayed figure makes the bot honour what the customer
    // was shown. It LOWERS risk for those strategies; it cannot raise it,
    // because everything downstream still clamps.
    const promisedLeverage = isLeverageSelectable
      ? chosenLeverage
      : clampLeverage(reqs?.leverage ?? 10);


    setSaving(true);
    try {
      const { data: conn, error: connErr } = await supabase
        .from("exchange_connections")
        .select("id")
        .eq("user_id", user.id)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (connErr) throw connErr;
      if (!conn) throw new Error("Connect an exchange before selecting a strategy.");
      const { error: usErr } = await supabase.from("user_strategy").upsert(
        {
          user_id: user.id,
          connection_id: conn.id,
          strategy_id: strategy.id,
          market_type: isFutures ? "futures" : "spot",
        },
        { onConflict: "user_id,connection_id,symbol" },
      );
      if (usErr) throw usErr;

      // THE HOP THAT WAS MISSING.
      //
      // `profiles.current_leverage_tier` drives this UI, but the WORKER reads
      // `active_bot_config.params`, which is `user_strategy.params`. Without
      // writing it there the customer's choice never reached sizing and every
      // entry silently used the pilot ceiling — so picking 50x gave 100x.
      //
      // Read-modify-write rather than a bare upsert. `params` is a shared
      // strategy-settings blob — earlier versions of the `active_bot_config`
      // view even sourced the symbol from it via `params->>'symbol'` — so
      // replacing the object wholesale would silently drop whatever else it
      // holds. Merge one key; touch nothing else.
      if (isFutures) {
        const { data: rows, error: paramsReadErr } = await supabase
          .from("user_strategy")
          .select("symbol, params")
          .eq("user_id", user.id)
          .eq("connection_id", conn.id);
        if (paramsReadErr) throw paramsReadErr;
        for (const row of rows ?? []) {
          const existing =
            row.params && typeof row.params === "object" && !Array.isArray(row.params)
              ? (row.params as Record<string, unknown>)
              : {};
          // Keyed on (user_id, connection_id, symbol) — user_strategy has no
          // surrogate id.
          const { error: paramsErr } = await supabase
            .from("user_strategy")
            .update({ params: { ...existing, leverage: promisedLeverage } })
            .eq("user_id", user.id)
            .eq("connection_id", conn.id)
            .eq("symbol", row.symbol);
          if (paramsErr) throw paramsErr;
        }
      }

      const { data: prof, error: rdErr } = await supabase
        .from("profiles")
        .select("target_budget_items")
        .eq("id", user.id)
        .maybeSingle();
      if (rdErr) throw rdErr;
      const buckets = normalizeBuckets(prof?.target_budget_items);

      // Persist edits to ALL buckets' items + targets
      (Object.keys(buckets) as BucketKey[]).forEach((k) => {
        const its = allBucketItems[k] ?? buckets[k].items;
        const tgt = its.reduce((s, it) => s + (Number(it.amount) || 0), 0);
        buckets[k] = { ...buckets[k], items: its, target: tgt };
      });

      // Detach this strategy from other buckets, attach to selected
      (Object.keys(buckets) as BucketKey[]).forEach((k) => {
        if (k !== bucket && buckets[k].active_strategy === strategy.id) {
          buckets[k].active_strategy = null;
        }
      });
      buckets[bucket].active_strategy = strategy.id;

      const { error: pErr } = await supabase
        .from("profiles")
        .update({
          active_goal_name: strategy.suit_name,
          active_goal_target: buckets[bucket].target,
          active_wallet_usd: clamped,
          target_budget_items: buckets as any,
          ...(isLeverageSelectable
            ? { current_leverage_tier: chosenLeverage }
            : {}),
        })

        .eq("id", user.id);
      if (pErr) throw pErr;

      toast.success(`${strategy.suit_name} saved to ${bucket}`);
      onSaved();
    } catch (e: any) {
      toast.error(e?.message ?? "Could not save strategy");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md rounded-2xl border-white/10 bg-background/95 backdrop-blur-xl">
        <DialogHeader>
          <DialogTitle>Configure {strategy.suit_name}</DialogTitle>
          <DialogDescription className="line-clamp-2">{strategy.description}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-4 overflow-y-auto py-2 pr-1">
          {/* 1. Strategy Name */}
          <div className="space-y-1.5">
            <Label htmlFor="sname">Strategy Name</Label>
            <div
              id="sname"
              className="inline-flex rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-sm font-semibold text-foreground"
            >
              {strategy.suit_name}
            </div>
          </div>

          {/* 2. Strategy Goal */}
          <div className="space-y-1.5">
            <Label>Strategy Goal</Label>
            <div className="inline-flex rounded-full border border-positive/30 bg-positive/10 px-3 py-1 text-[12px] font-semibold text-positive">
              {goalLabel}
            </div>
          </div>


          {/* 3.5 User-selected leverage ceiling for every futures-capable strategy */}
          {isLeverageSelectable && loaded && (
            <div className="space-y-1.5">
            <Label>Leverage (up to 100×)</Label>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Choose any leverage from 1× to 100×. TurtleBot may approve a lower value when the exchange, symbol, account, strategy, or risk limit is lower.
              </p>
              <LeverageSelector
                key={`lev-init-${initialLoadedLeverage}`}
                initialLeverage={initialLoadedLeverage ?? leverage}
                capital={Number(capital) || 0}
                strategySlug={strategy.slug}
                onChange={(lev, rPct, posSize) => {
                  setLeverage(lev);
                  setRiskPct(rPct);
                  setPositionSize(posSize);
                }}
              />
            </div>
          )}

          {/* 4. Trade Requirements */}
          <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.04] p-3">
            <Label className="text-[10.5px] uppercase tracking-wider text-muted-foreground">
              Trade Requirements
            </Label>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px]">
              <ReqRow label="Stop Loss" value={`${displayedStopLoss}%`} />
              <ReqRow label="Take Profit 1" value={`${reqs?.takeProfit1Pct ?? "—"}% ROI`} />
              <ReqRow label="Take Profit 2" value={`${reqs?.takeProfit2Pct ?? "—"}% ROI`} />
              <ReqRow
                label="Take Profit 3"
                value={`${reqs?.takeProfit3Pct ?? "—"}% (${reqs?.takeProfit3Action ?? "—"})`}
              />
              {isLeverageSelectable ? (
                <>
                  <ReqRow label="Leverage" value={`${leverage}x`} />
                  <ReqRow label="Position Size" value={`$${positionSize.toLocaleString()}`} />
                </>
              ) : (
                isFutures && <ReqRow label="Leverage" value={`${reqs?.leverage ?? 10}x`} />
              )}
            </div>
          </div>

          {/* 5. Buckets — click to expand items, fill, save */}
          <div className="space-y-1.5">
            <Label>Buckets</Label>
            <p className="text-[11px] text-muted-foreground">
              Tap a bucket to edit its items. The selected bucket (✓) is where this strategy will be assigned.
            </p>
            <div className="space-y-2">
              {BUCKETS.map((b) => {
                const isSelected = bucket === b.key;
                const isOpen = expandedKey === b.key;
                const Icon = ICON_MAP[b.icon] ?? Wallet;
                const bItems = allBucketItems[b.key];
                const bTotal = bItems.reduce((s, it) => s + (Number(it.amount) || 0), 0);
                return (
                  <div
                    key={b.key}
                    className={`overflow-hidden rounded-xl border transition ${
                      isSelected
                        ? "border-primary/25 bg-primary/[0.06]"
                        : "border-white/[0.06] bg-white/[0.02]"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setBucket(b.key);
                        setExpandedKey(isOpen ? null : b.key);
                      }}
                      className="flex w-full items-center gap-2.5 px-2.5 py-2.5 text-left transition hover:bg-white/[0.03]"
                    >
                      <span
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                          isSelected
                            ? "bg-primary/15 text-primary"
                            : "bg-white/[0.05] text-muted-foreground"
                        }`}
                      >
                        <Icon className="h-4 w-4" strokeWidth={1.75} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-[13px] font-semibold">{b.label}</p>
                          {isSelected && (
                            <Check className="h-3.5 w-3.5 text-primary" strokeWidth={2.5} />
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground">{b.hint}</p>
                      </div>
                      <span className="num rounded-full bg-positive/15 px-2 py-0.5 text-[11px] font-bold text-positive tabular-nums">
                        ${bTotal.toLocaleString()}
                      </span>
                      <ChevronDown
                        className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                          isOpen ? "rotate-180" : ""
                        }`}
                      />
                    </button>

                    {isOpen && (
                      <div className="space-y-1.5 border-t border-white/[0.06] bg-black/20 px-2.5 py-2.5">
                        {!loaded && (
                          <p className="py-2 text-center text-[12px] text-muted-foreground">
                            Loading…
                          </p>
                        )}
                        {loaded &&
                          bItems.map((it, idx) => {
                            const ItIcon = ICON_MAP[it.icon] ?? Wallet;
                            return (
                              <div
                                key={it.id}
                                className="group flex items-center gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 transition hover:border-white/10 hover:bg-white/[0.04]"
                              >
                                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/[0.05] text-muted-foreground">
                                  <ItIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
                                </span>
                                <Input
                                  value={it.label}
                                  onChange={(e) =>
                                    updateItem(b.key, idx, { label: e.target.value })
                                  }
                                  className="h-7 flex-1 border-0 bg-transparent px-0 text-[13px] font-medium tracking-tight shadow-none focus-visible:ring-0"
                                />
                                <div className="flex items-center gap-1 rounded-md border border-white/[0.06] bg-black/40 pl-2 pr-1">
                                  <span className="text-[11px] font-medium text-muted-foreground">
                                    $
                                  </span>
                                  <Input
                                    type="number"
                                    min={0}
                                    value={it.amount}
                                    onChange={(e) =>
                                      updateItem(b.key, idx, {
                                        amount: Number(e.target.value) || 0,
                                      })
                                    }
                                    className="num h-6 w-20 border-0 bg-transparent px-1 text-right text-[13px] font-semibold tabular-nums shadow-none focus-visible:ring-0"
                                  />
                                </div>
                                <button
                                  type="button"
                                  onClick={() => removeItem(b.key, idx)}
                                  className="rounded-md p-1 text-muted-foreground/50 opacity-0 transition hover:bg-white/5 hover:text-foreground group-hover:opacity-100"
                                  aria-label="Remove item"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            );
                          })}

                        <button
                          type="button"
                          onClick={() => addItem(b.key)}
                          className="mt-1 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-white/15 px-2 py-1.5 text-[12px] text-muted-foreground transition hover:bg-white/5 hover:text-foreground"
                        >
                          <Plus className="h-3.5 w-3.5" /> Add item
                        </button>
                        <div className="flex items-center justify-between border-t border-white/10 pt-2 text-[12px]">
                          <span className="text-muted-foreground">Bucket total</span>
                          <span className="num font-semibold tabular-nums">
                            ${bTotal.toLocaleString()}
                          </span>
                        </div>
                        <Button
                          size="sm"
                          className="w-full"
                          onClick={() => setExpandedKey(null)}
                        >
                          Done
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Save Strategy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReqRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-semibold text-foreground">{value}</span>
    </>
  );
}
