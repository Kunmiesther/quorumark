/**
 * TurtleBot — single source of truth for the six official turtles.
 *
 * Images are the LOCKED masters — never regenerate, rotate, recolor, or remap.
 * Replace ONLY `src/assets/turtle-*.png`. The image→name mapping below
 * SUPERSEDES any earlier mapping.
 *
 * Slugs match the DB (`public.strategies.slug`). Do NOT add/remove/rename
 * without a migration. `key` is the URL segment (lowercase name) for
 * /squad/$key. Accents come from THIS file — never from
 * `public.strategies.ring_color` (that column is stale and contradicts the
 * finalised identities).
 *
 * IMPORTANT: turtle accents must never collide with system semantic colors
 * (violet #A855F7 primary, danger #EF4444, warning #F59E0B, success #10B981).
 * The `turtles.test.ts` collision guard enforces this.
 */

import { TURTLE_IMAGES, turtleImage as _turtleImage } from "./turtle-images";

export type TurtleRisk = "low" | "medium" | "high";

export interface TurtleDef {
  /** DB slug (`public.strategies.slug`). */
  slug: string;
  /** Canonical URL key = official name lowercased. */
  key: string;
  /** Official name — one of the six. */
  name: string;
  suit: string;
  role: string;
  personality: string;
  bestConditions: string;
  biome: string;
  risk: TurtleRisk;
  tool: string;
  /** Selective accent — used sparingly, NEVER as a system color. */
  accent: string;
  /** Optional secondary accent (armor detail / trim). */
  accentSoft?: string;
  image: string;
}

export const TURTLES: readonly TurtleDef[] = [
  {
    slug: "break-retest",
    key: "vanguard",
    name: "Vanguard",
    suit: "The Vanguard",
    role: "Frontline momentum specialist",
    personality: "Bold, forceful, disciplined",
    bestConditions: "Trending breakouts and high momentum",
    biome: "volcanic",
    risk: "medium",
    tool: "Vanguard Staff",
    accent: "#F2542D",
    image: TURTLE_IMAGES["break-retest"],
  },
  {
    slug: "dca",
    key: "accumulator",
    name: "Accumulator",
    suit: "The Accumulator",
    role: "Patient DCA and position-building specialist",
    personality: "Patient, methodical, persistent",
    bestConditions: "Ranging and accumulation phases",
    biome: "deep-vault",
    risk: "low",
    tool: "Accumulator Staff",
    accent: "#2DD4BF",
    accentSoft: "#99F6E4",
    image: TURTLE_IMAGES.dca,
  },
  {
    slug: "rsi-divergence",
    key: "sniper",
    name: "Sniper",
    suit: "The Sniper",
    role: "Precision-entry specialist",
    personality: "Selective, calculated, observant",
    bestConditions: "Exhaustion and reversal zones",
    biome: "shattered-glass",
    risk: "medium",
    tool: "Precision Targeting System",
    accent: "#C026D3",
    image: TURTLE_IMAGES["rsi-divergence"],
  },
  {
    slug: "ema-cross",
    key: "scout",
    name: "Scout",
    suit: "The Scout",
    role: "Market reconnaissance and early-detection specialist",
    personality: "Fast, intelligent, alert",
    bestConditions: "Early trend shifts",
    biome: "storm",
    risk: "medium",
    tool: "Signal Staff",
    accent: "#5EEAD4",
    image: TURTLE_IMAGES["ema-cross"],
  },
  {
    slug: "liq-hunting",
    key: "hunter",
    name: "Hunter",
    suit: "The Hunter",
    role: "Opportunity-tracking specialist",
    personality: "Persistent, adaptive, resourceful",
    bestConditions: "High volatility and liquidation cascades",
    biome: "desert",
    risk: "high",
    tool: "Tracking Spear",
    accent: "#B87333",
    image: TURTLE_IMAGES["liq-hunting"],
  },
  {
    slug: "funding-arb",
    key: "arbiter",
    name: "Arbiter",
    suit: "The Arbiter",
    role: "Market-neutral funding and spread specialist",
    personality: "Controlled, authoritative, analytical",
    bestConditions: "Funding dislocations and cross-venue spreads",
    biome: "command-floor",
    risk: "low",
    tool: "The Balance Staff",
    accent: "#60A5FA",
    accentSoft: "#C9A227",
    image: TURTLE_IMAGES["funding-arb"],
  },
] as const;

const BY_SLUG: Readonly<Record<string, TurtleDef>> = Object.freeze(
  TURTLES.reduce<Record<string, TurtleDef>>((acc, t) => {
    acc[t.slug] = t;
    return acc;
  }, {}),
);

const BY_KEY: Readonly<Record<string, TurtleDef>> = Object.freeze(
  TURTLES.reduce<Record<string, TurtleDef>>((acc, t) => {
    acc[t.key] = t;
    return acc;
  }, {}),
);

export function turtleBySlug(slug: string): TurtleDef | null {
  return BY_SLUG[slug] ?? null;
}

/** Match by canonical `key` (name.toLowerCase()) OR by DB `slug`. */
export function turtleByAnyKey(key: string): TurtleDef | null {
  if (!key) return null;
  const k = key.toLowerCase();
  return BY_KEY[k] ?? BY_SLUG[k] ?? null;
}

export function turtleImage(slug: string): string {
  return _turtleImage(slug);
}

/** Resolve a turtle's accent from a DB slug — the ONLY sanctioned source
 *  for turtle accent colors. Never read `strategies.ring_color`. */
export function turtleAccent(slug: string, fallback = "var(--primary)"): string {
  return BY_SLUG[slug]?.accent ?? fallback;
}
