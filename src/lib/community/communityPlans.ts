/**
 * Community plan catalog — the ONLY place plan keys are defined.
 *
 * These keys are referenced by access_entitlements.plan_key,
 * community_invitations.plan_key and trading_communities.plan_key.
 *
 * IMPORTANT: no plan grants live trading. Live execution is owner-only and
 * resolved exclusively from the admin role — never from an entitlement.
 */

export type CommunityPlanKey =
  | "free_paper_trial"
  | "scout"
  | "agentic"
  | "pro"
  | "fusion";

export interface CommunityPlanDef {
  key: CommunityPlanKey;
  name: string;
  /** Paper trading surface. Every plan has it — this is a paper-first product. */
  paper: true;
  /** Access to the AI Decision Room. */
  decisionRoom: boolean;
  /** Access to the Agentic Command Center. */
  agentic: boolean;
  description: string;
}

export const COMMUNITY_PLANS: Readonly<Record<CommunityPlanKey, CommunityPlanDef>> = {
  free_paper_trial: {
    key: "free_paper_trial",
    name: "Free Paper Trial",
    paper: true,
    decisionRoom: false,
    agentic: false,
    description: "Paper trading with the deterministic pipeline.",
  },
  scout: {
    key: "scout",
    name: "Scout",
    paper: true,
    decisionRoom: true,
    agentic: false,
    description: "Paper trading plus the AI Decision Room.",
  },
  agentic: {
    key: "agentic",
    name: "Agentic",
    paper: true,
    decisionRoom: true,
    agentic: true,
    description: "Paper trading, Decision Room and the Agentic Command Center.",
  },
  pro: {
    key: "pro",
    name: "Pro",
    paper: true,
    decisionRoom: true,
    agentic: true,
    description: "Everything in Agentic with priority orchestration.",
  },
  fusion: {
    key: "fusion",
    name: "Fusion",
    paper: true,
    decisionRoom: true,
    agentic: true,
    description: "Everything in Pro for partnered communities.",
  },
};

export const DEFAULT_PLAN_KEY: CommunityPlanKey = "free_paper_trial";

export function isCommunityPlanKey(value: string): value is CommunityPlanKey {
  return Object.prototype.hasOwnProperty.call(COMMUNITY_PLANS, value);
}

export function planDef(key: string): CommunityPlanDef {
  return isCommunityPlanKey(key)
    ? COMMUNITY_PLANS[key]
    : COMMUNITY_PLANS[DEFAULT_PLAN_KEY];
}
