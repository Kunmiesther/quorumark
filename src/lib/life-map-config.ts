/**
 * Life Map category extensions (P3).
 *
 * Do NOT duplicate BUCKETS/BucketKey from strategy-config.ts. This module
 * augments them with the four new canonical Life Map categories and a
 * union type that also allows user-created custom keys.
 */
import {
  BUCKETS,
  DEFAULT_BUDGET_ITEMS,
  normalizeBuckets,
  type BucketKey,
  type BucketDef,
  type BucketState,
  type BudgetItem,
  type TargetBudgetItems,
} from "./strategy-config";

/** The four new canonical categories added in P3. */
export type ExtraLifeCategoryKey = "body" | "family" | "debt" | "future";

/** Union of the 8 canonical seeded keys. */
export type CanonicalLifeCategoryKey = BucketKey | ExtraLifeCategoryKey;

/**
 * Any Life Map category key: one of the 8 canonical keys, or a user-created
 * custom key (arbitrary string; enforced unique per user at the DB layer).
 */
export type LifeCategoryKey = CanonicalLifeCategoryKey | (string & {});

export interface LifeCategoryDef {
  key: CanonicalLifeCategoryKey;
  label: string;
  icon: string;
  is_essential: boolean;
  sort_order: number;
}

/** Canonical seed definitions — must match the P3 migration seed set. */
export const CANONICAL_LIFE_CATEGORIES: readonly LifeCategoryDef[] = [
  { key: "roof",     label: "Roof",     icon: "home",        is_essential: true,  sort_order: 1 },
  { key: "ride",     label: "Ride",     icon: "car",         is_essential: true,  sort_order: 2 },
  { key: "memories", label: "Memories", icon: "camera",      is_essential: false, sort_order: 3 },
  { key: "escape",   label: "Escape",   icon: "plane",       is_essential: false, sort_order: 4 },
  { key: "body",     label: "Body",     icon: "heart",       is_essential: true,  sort_order: 5 },
  { key: "family",   label: "Family",   icon: "users",       is_essential: false, sort_order: 6 },
  { key: "debt",     label: "Debt",     icon: "credit-card", is_essential: true,  sort_order: 7 },
  { key: "future",   label: "Future",   icon: "sparkles",    is_essential: false, sort_order: 8 },
] as const;

/** Rows that would be inserted into life_obligations from a legacy JSON blob. */
export interface NormalizedObligationRow {
  category_key: BucketKey;
  name: string;
  amount: number;
  currency: "USD";
  kind: "bill";
  is_essential: boolean;
  legacy_item_id: string;
}

/**
 * Pure normalization helper — mirrors the SQL migration logic.
 *
 * Takes a target_budget_items JSON blob (as stored on public.profiles) and
 * returns the flat list of obligation rows that would be created for it,
 * skipping unknown buckets and malformed items. Amounts are coerced safely.
 * Running it twice on the same input MUST produce identical output.
 */
export function normalizeTargetBudgetItemsToObligations(
  raw: unknown,
): NormalizedObligationRow[] {
  if (!raw || typeof raw !== "object") return [];
  const known: BucketKey[] = ["roof", "ride", "memories", "escape"];
  const essentialBuckets = new Set<BucketKey>(["roof", "ride"]);
  const out: NormalizedObligationRow[] = [];
  const src = raw as Record<string, unknown>;

  for (const key of known) {
    const bucket = src[key];
    if (!bucket || typeof bucket !== "object") continue;
    const items = (bucket as { items?: unknown }).items;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      // Matches the SQL guard `item->>'id' IS NOT NULL` — only string ids from
      // the raw JSON qualify, never a synthesized fallback.
      const legacy_item_id = typeof rec.id === "string" ? rec.id : null;
      if (!legacy_item_id) continue;
      const rawAmount = Number(rec.amount);
      const amount = Number.isFinite(rawAmount) ? rawAmount : 0;
      const label = rec.label;
      out.push({
        category_key: key,
        name: typeof label === "string" && label.length > 0 ? label : "Item",
        amount,
        currency: "USD",
        kind: "bill",
        is_essential: essentialBuckets.has(key),
        legacy_item_id,
      });
    }
  }
  return out;
}

// Re-export what callers commonly need alongside the new types.
export {
  BUCKETS,
  DEFAULT_BUDGET_ITEMS,
  normalizeBuckets,
  type BucketKey,
  type BucketDef,
  type BucketState,
  type BudgetItem,
  type TargetBudgetItems,
};
