/**
 * Subscription tiers — single source of truth for user-facing plan labels.
 * Must match `public.subscription_tier` DB enum.
 */
export const SUBSCRIPTION_TIERS = ["free", "ion", "arc", "orb", "zen"] as const;
export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

export const SUBSCRIPTION_TIER_LABEL: Record<SubscriptionTier, string> = {
  free: "Free",
  ion: "ION",
  arc: "ARC",
  orb: "ORB",
  zen: "ZEN",
};
