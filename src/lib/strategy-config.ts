/**
 * Static per-strategy trade requirements + bucket definitions.
 * Displayed in the Strategy Configuration form; enforced by the trading engine later.
 */

export type BucketKey = "roof" | "ride" | "memories" | "escape";

export interface BucketDef {
  key: BucketKey;
  label: string;
  icon: string;
  hint: string;
}

export const BUCKETS: BucketDef[] = [
  { key: "roof", label: "Roof", icon: "home", hint: "Home / rent / repairs" },
  { key: "ride", label: "Ride", icon: "car", hint: "Car / transport" },
  { key: "memories", label: "Memories", icon: "camera", hint: "Family / experiences" },
  { key: "escape", label: "Escape", icon: "plane", hint: "Travel / vacation" },
];

export interface StrategyRequirements {
  goalLabel: string;
  stopLossPct: number;
  takeProfit1Pct: number;
  takeProfit2Pct: number;
  takeProfit3Pct: number;
  takeProfit3Action: "cash-out" | "compound";
  leverage?: number;
}

/**
 * Customer-selectable leverage on ApeX.
 *
 * 1 is the floor, not 0. ApeX has no 0x leverage — 0 means "no position",
 * which is expressed by not trading rather than by a leverage value. The
 * worker's `pilot_leverage` has always applied `max(1, ...)`, so offering 0
 * would show a number that silently means 1.
 *
 * 100 is the ceiling because that is where it is actually enforced, in three
 * independent places: `pilot.max_leverage` in
 * shared/mainnet_parity_constants.json (loaded by the broker translator and
 * the worker sizing helper), the signer's `max(1, min(100, leverage))`, and
 * the live venue ceiling from the ApeX contract.
 *
 * This previously offered 200/300/400/500 as well. None of them were
 * reachable — every one was silently clamped to 100 — so the picker was
 * telling customers something the system could not do.
 */
export const MIN_SELECTABLE_LEVERAGE = 1;
export const MAX_SELECTABLE_LEVERAGE = 100;

/**
 * Legacy leverage -> stop-distance table.
 *
 * RETAINED FOR REFERENCE ONLY: entries above MAX_SELECTABLE_LEVERAGE are not
 * reachable at the venue. `getLeverageRisk` no longer reads this map — it
 * uses the closed form below, which reproduces every entry here EXACTLY
 * (500->2, 400->4, 300->6, 200->8, 100->10, 50->11), so nothing about the
 * previously selectable values changes.
 */
export const LEVERAGE_RISK_MAP: Record<number, number> = {
  500: 2,
  400: 4,
  300: 6,
  200: 8,
  100: 10,
  50: 11,
};

/**
 * Stop distance for a chosen leverage, as a percentage.
 *
 * The table above is exactly linear — `12 - leverage / 50` — so extending to
 * a continuous 1..100 range is a continuation of the ratified rule, not a new
 * one. It also removes the old `?? 5` fallback, which handed any unlisted
 * leverage a 5% stop: tighter than every value in the table, and applied
 * precisely when the caller had asked for something nobody had considered.
 */
export function getLeverageRisk(leverage: number): number {
  const lev = Number.isFinite(leverage) ? leverage : MAX_SELECTABLE_LEVERAGE;
  const clamped = Math.min(
    Math.max(lev, MIN_SELECTABLE_LEVERAGE),
    MAX_SELECTABLE_LEVERAGE,
  );
  return Math.round((12 - clamped / 50) * 100) / 100;
}

/** Clamp any leverage to what the venue and the ratified ceiling allow. */
export function clampLeverage(leverage: number): number {
  const lev = Number.isFinite(leverage)
    ? Math.round(leverage)
    : MAX_SELECTABLE_LEVERAGE;
  return Math.min(
    Math.max(lev, MIN_SELECTABLE_LEVERAGE),
    MAX_SELECTABLE_LEVERAGE,
  );
}

/**
 * Futures-capable strategies where leverage is a customer-selected ceiling.
 *
 * The configured value is a request, never a command: execution still uses
 * the lowest of the customer choice, strategy cap, verified venue/symbol cap,
 * account eligibility, and the risk engine's safe cap.
 */
export const UNIFIED_LEVERAGE_STRATEGIES = new Set([
  "dca",
  "break-retest",
  "rsi-divergence",
  "ema-cross",
  "funding-arb",
  "liq-hunting",
]);

export const STRATEGY_REQUIREMENTS: Record<string, StrategyRequirements> = {
  dca:               { goalLabel: "200% ROI", stopLossPct: getLeverageRisk(100), takeProfit1Pct: 50,  takeProfit2Pct: 100, takeProfit3Pct: 200, takeProfit3Action: "cash-out", leverage: 100 },
  "break-retest":    { goalLabel: "500% ROI", stopLossPct: getLeverageRisk(100), takeProfit1Pct: 125, takeProfit2Pct: 250, takeProfit3Pct: 500, takeProfit3Action: "cash-out", leverage: 100 },
  "rsi-divergence":  { goalLabel: "120% ROI", stopLossPct: 6,  takeProfit1Pct: 30,  takeProfit2Pct: 60,  takeProfit3Pct: 120, takeProfit3Action: "cash-out", leverage: 5 },
  "ema-cross":       { goalLabel: "180% ROI", stopLossPct: 7,  takeProfit1Pct: 45,  takeProfit2Pct: 90,  takeProfit3Pct: 180, takeProfit3Action: "cash-out", leverage: 10 },
  "funding-arb":     { goalLabel: "60% APY",  stopLossPct: 3,  takeProfit1Pct: 15,  takeProfit2Pct: 30,  takeProfit3Pct: 60,  takeProfit3Action: "cash-out", leverage: 5 },
  "liq-hunting":     { goalLabel: "300% ROI", stopLossPct: 10, takeProfit1Pct: 75,  takeProfit2Pct: 150, takeProfit3Pct: 300, takeProfit3Action: "cash-out", leverage: 20 },
};

export interface BudgetItem {
  id: string;
  icon: string;
  label: string;
  amount: number;
  locked?: boolean;
}

export const DEFAULT_BUDGET_ITEMS: Record<BucketKey, BudgetItem[]> = {
  roof: [
    { id: "rent",     icon: "home",       label: "Rent",        amount: 1200 },
    { id: "light",    icon: "lightbulb",  label: "Light Bill",  amount: 110 },
    { id: "water",    icon: "droplet",    label: "Water Bill",  amount: 65 },
    { id: "internet", icon: "wifi",       label: "Internet",    amount: 50 },
    { id: "phone",    icon: "smartphone", label: "Cell Phone",  amount: 45 },
  ],
  ride: [
    { id: "payment",   icon: "car",        label: "Car Payment",     amount: 0 },
    { id: "service",   icon: "wrench",     label: "Service/Repairs", amount: 0 },
    { id: "insurance", icon: "shield",     label: "Insurance",       amount: 0 },
    { id: "tax",       icon: "file-text",  label: "Tax/Tag",         amount: 0 },
  ],
  memories: [
    { id: "wedding",     icon: "heart",     label: "Wedding",     amount: 0 },
    { id: "birthday",    icon: "cake",      label: "Birthday",    amount: 0 },
    { id: "anniversary", icon: "gift",      label: "Anniversary", amount: 0 },
    { id: "christmas",   icon: "tree-pine", label: "Christmas",   amount: 0 },
  ],
  escape: [
    { id: "hotel",      icon: "bed",        label: "Hotel",      amount: 0 },
    { id: "flight",     icon: "plane",      label: "Flight",     amount: 0 },
    { id: "rental",     icon: "car-front",  label: "Rental",     amount: 0 },
    { id: "excursions", icon: "ticket",     label: "Excursions", amount: 0 },
  ],
};


export interface BucketState {
  target: number;
  current: number;
  active_strategy: string | null;
  items: BudgetItem[];
}

export type TargetBudgetItems = Record<BucketKey, BucketState>;

export function emptyBuckets(): TargetBudgetItems {
  return {
    roof:     { target: 0, current: 0, active_strategy: null, items: [] },
    ride:     { target: 0, current: 0, active_strategy: null, items: [] },
    memories: { target: 0, current: 0, active_strategy: null, items: [] },
    escape:   { target: 0, current: 0, active_strategy: null, items: [] },
  };
}

function coerceItems(raw: unknown): BudgetItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((it: any) => {
      if (!it || typeof it !== "object") return null;
      return {
        id: String(it.id ?? it.label ?? Math.random().toString(36).slice(2)),
        icon: typeof it.icon === "string" ? it.icon : "•",
        label: String(it.label ?? "Item"),
        amount: Number(it.amount) || 0,
        locked: !!it.locked,
      } as BudgetItem;
    })
    .filter(Boolean) as BudgetItem[];
}

export function normalizeBuckets(raw: unknown): TargetBudgetItems {
  const base = emptyBuckets();
  if (!raw || typeof raw !== "object") return base;
  for (const k of Object.keys(base) as BucketKey[]) {
    const v = (raw as Record<string, any>)[k];
    if (v && typeof v === "object") {
      base[k] = {
        target: Number(v.target) || 0,
        current: Number(v.current) || 0,
        active_strategy: v.active_strategy ?? null,
        items: coerceItems(v.items),
      };
    }
  }
  return base;
}

export function getItemsOrDefault(bucket: BucketKey, items: BudgetItem[]): BudgetItem[] {
  return items.length > 0 ? items : DEFAULT_BUDGET_ITEMS[bucket].map((i) => ({ ...i }));
}

