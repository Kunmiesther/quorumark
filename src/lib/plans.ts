/**
 * Turtle Bot plan catalog — single source of truth for pricing, wallet
 * limits, symbol scope, Onyx level, and Life Mode auto-funding.
 *
 * Read by the pricing page AND by future gating logic elsewhere in the app.
 * Prices are exact and intentional: 0 / 98 / 198 / 349 / 999 USD/mo.
 *
 * IMPORTANT: this file does NOT enable live trading. Live execution stays
 * gated until the forward test proves out — plans can exist without
 * unlocking real orders.
 */

import type { SubscriptionTier } from "./subscription-tiers";

export type SymbolsScope = "none" | "majors" | "extended" | "all" | "all+lab";
export type OnyxLevel = "none" | "basic" | "insights" | "copilot" | "priority";

export interface PlanDef {
  key: SubscriptionTier;
  name: string;
  tagline: string;
  /** Monthly price in USD. 0 for free. */
  priceMonthly: number;
  /** Number of LIVE trading wallets. 0 = paper only. */
  walletLimit: number;
  symbolsScope: SymbolsScope;
  onyxLevel: OnyxLevel;
  /** ORB+ headline: bot gains auto-flow toward bills. */
  lifeModeAutofund: boolean;
  /** Priority execution / support. */
  priority: boolean;
  /** Marketing pill — used to visually feature the "unlock" tier. */
  featured?: boolean;
  cta: string;
  /** Short scannable list. Use "Everything in X, plus…" phrasing where it fits. */
  features: string[];
}

export const PLANS: readonly PlanDef[] = [
  {
    key: "free",
    name: "Free",
    tagline: "Prove It",
    priceMonthly: 0,
    walletLimit: 0,
    symbolsScope: "none",
    onyxLevel: "none",
    lifeModeAutofund: false,
    priority: false,
    cta: "Start free",
    features: [
      "Full paper-testing lab (all symbols, 20 paper wallets)",
      "Watch the edge work in real time",
      "Life Map — planning (bills, milestones, Onyx's plan)",
      "Watch-only — no live trading",
    ],
  },
  {
    key: "ion",
    name: "ION",
    tagline: "Deploy It",
    priceMonthly: 98,
    walletLimit: 2,
    symbolsScope: "majors",
    onyxLevel: "basic",
    lifeModeAutofund: false,
    priority: false,
    cta: "Choose ION",
    features: [
      "Everything in Free, plus:",
      "Live trading — 2 wallets",
      "Symbols: majors only (BTC, ETH, SOL)",
      "Onyx: basic",
      "Life Map — planning",
    ],
  },
  {
    key: "arc",
    name: "ARC",
    tagline: "Expand It",
    priceMonthly: 198,
    walletLimit: 4,
    symbolsScope: "extended",
    onyxLevel: "insights",
    lifeModeAutofund: false,
    priority: false,
    cta: "Choose ARC",
    features: [
      "Everything in ION, plus:",
      "Live trading — 4 wallets",
      "Symbols: + XRP, DOGE, and more",
      "Onyx: insights",
    ],
  },
  {
    key: "orb",
    name: "ORB",
    tagline: "Automate It",
    priceMonthly: 349,
    walletLimit: 6,
    symbolsScope: "all",
    onyxLevel: "copilot",
    lifeModeAutofund: true,
    priority: false,
    featured: true,
    cta: "Choose ORB",
    features: [
      "Everything in ARC, plus:",
      "Live trading — 6 wallets",
      "Symbols: all available",
      "Life Mode auto-funding — bot gains flow toward bills automatically",
      "Full Onyx co-pilot (autonomous assistant)",
    ],
  },
  {
    key: "zen",
    name: "ZEN",
    tagline: "Master It",
    priceMonthly: 999,
    walletLimit: 20,
    symbolsScope: "all+lab",
    onyxLevel: "priority",
    lifeModeAutofund: true,
    priority: true,
    cta: "Choose ZEN",
    features: [
      "Everything in ORB, plus:",
      "Live trading — 20 wallets",
      "All symbols + experimental lab",
      "Priority execution",
      "Priority Onyx",
    ],
  },
] as const;

export function planByKey(key: SubscriptionTier): PlanDef {
  return PLANS.find((p) => p.key === key) ?? PLANS[0];
}
