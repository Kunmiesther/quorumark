/**
 * Canonical Life Map catalog.
 *
 * `CATEGORIES` — the 8 buckets used across the dashboard, donut chart,
 * bar chart, and category grid drawer. Keys are stable — they persist
 * in `bills.category`.
 *
 * `STRATEGIES` — the bots the user can assign to a bill. `key` matches
 * `user_strategy_toggles.strategy` and `paper_positions.strategy` so the
 * activation switch and the trade→bill sync agree on the same identifier.
 */
import {
  Home,
  Car,
  CreditCard,
  Plane,
  HeartPulse,
  Sparkles,
  Radar,
  Zap,
  Target,
  Crosshair,
  type LucideIcon,
} from "lucide-react";
import { turtleImage } from "@/lib/turtle-images";

export interface CategoryPreset {
  /** Suggested bill name. */
  name: string;
  /** Typical monthly amount in USD — user can adjust before saving. */
  amount: number;
  cadence?: "monthly" | "weekly" | "one_time";
  due_day?: number;
}

export interface LifeCategory {
  key: string;
  label: string;
  blurb: string;
  icon: LucideIcon;
  accent: string; // hex, for charts + tile accent
  /** One-tap suggestions so the user barely has to type. */
  presets: CategoryPreset[];
}

export const CATEGORIES: LifeCategory[] = [
  {
    key: "roof",
    label: "Roof",
    blurb: "Home, utilities, and family.",
    icon: Home,
    accent: "#9945FF",
    presets: [
      { name: "Rent", amount: 1800 },
      { name: "Mortgage", amount: 2200 },
      { name: "Electric", amount: 120 },
      { name: "Water", amount: 55 },
      { name: "Gas", amount: 60 },
      { name: "Internet", amount: 75 },
      { name: "HOA", amount: 250 },
      { name: "Childcare", amount: 900 },
      { name: "Tuition", amount: 500 },
    ],
  },
  {
    key: "vehicle",
    label: "Vehicle",
    blurb: "Car payment, insurance, fuel.",
    icon: Car,
    accent: "#14F195",
    presets: [
      { name: "Car payment", amount: 450 },
      { name: "Auto insurance", amount: 140 },
      { name: "Fuel", amount: 200 },
      { name: "Maintenance", amount: 60 },
      { name: "Parking", amount: 120 },
    ],
  },
  {
    key: "credit",
    label: "Credit",
    blurb: "Cards, loans, minimums.",
    icon: CreditCard,
    accent: "#F97316",
    presets: [
      { name: "Credit card", amount: 150 },
      { name: "Personal loan", amount: 200 },
      { name: "Student loan", amount: 300 },
    ],
  },
  {
    key: "vacation",
    label: "Vacation",
    blurb: "Trips, memories, subscriptions.",
    icon: Plane,
    accent: "#22D3EE",
    presets: [
      { name: "Flights fund", amount: 200 },
      { name: "Hotel fund", amount: 150 },
      { name: "Streaming", amount: 25 },
      { name: "Concert / event", amount: 80 },
      { name: "Hobby / gear", amount: 60 },
    ],
  },
  {
    key: "body",
    label: "Body",
    blurb: "Gym, health, wellness.",
    icon: HeartPulse,
    accent: "#F43F5E",
    presets: [
      { name: "Gym", amount: 40 },
      { name: "Health insurance", amount: 280 },
      { name: "Therapy", amount: 120 },
      { name: "Medications", amount: 50 },
    ],
  },
  {
    key: "future",
    label: "Future",
    blurb: "Savings, investing, safety net.",
    icon: Sparkles,
    accent: "#FBBF24",
    presets: [
      { name: "Emergency fund", amount: 300 },
      { name: "Investing", amount: 250 },
      { name: "Retirement (Roth)", amount: 200 },
    ],
  },
];


export function categoryByKey(key: string | null | undefined): LifeCategory | undefined {
  if (!key) return undefined;
  return CATEGORIES.find((c) => c.key === key);
}

export interface TurtleStrategy {
  /** Persisted key — matches user_strategy_toggles.strategy + paper_positions.strategy. */
  key: string;
  label: string;
  blurb: string;
  icon: LucideIcon;
  accent: string;
}

export interface TurtleStrategyWithArt extends TurtleStrategy {
  /** Optional turtle portrait — bleeds into the activation tile. */
  image?: string;
}


export const STRATEGIES: TurtleStrategyWithArt[] = [
  {
    key: "vanguard",
    label: "Vanguard",
    blurb: "Frontline momentum — rides confirmed breakouts.",
    icon: Zap,
    accent: "#F2542D",
    image: turtleImage("break-retest"),
  },
  {
    key: "accumulator",
    label: "Accumulator",
    blurb: "Steady DCA — averages down through calm ranges.",
    icon: Zap,
    accent: "#14F195",
    image: turtleImage("dca"),
  },
  {
    key: "arbiter",
    label: "Arbiter",
    blurb: "Patient position-builder — balances risk across regimes.",
    icon: Target,
    accent: "#06B6D4",
    image: turtleImage("funding-arb"),
  },
  {
    key: "sniper",
    label: "Sniper",
    blurb: "Precision reversals from validated zones.",
    icon: Target,
    accent: "#C026D3",
    image: turtleImage("rsi-divergence"),
  },
  {
    key: "hunter",
    label: "Hunter",
    blurb: "Volatility specialist — trades FVG expansions.",
    icon: Crosshair,
    accent: "#B87333",
    image: turtleImage("liq-hunting"),
  },
];

export function strategyByKey(key: string | null | undefined): TurtleStrategy | undefined {
  if (!key) return undefined;
  return STRATEGIES.find((s) => s.key === key);
}

export const SCOUT_META = {
  label: "Scout",
  blurb: "Multi-timeframe recon. Watches every open trade for exit signals.",
  icon: Radar,
  accent: "#5EEAD4",
  image: turtleImage("ema-cross"),
};
