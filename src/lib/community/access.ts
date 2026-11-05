/**
 * Canonical access authority — pure resolution logic.
 *
 * This module is deliberately dependency-free so it can be unit tested and
 * reused by both server functions and tests. The server wrapper that reads
 * the database lives in `access.functions.ts`.
 *
 * HARD INVARIANT: `live` is derived ONLY from the admin role. No entitlement,
 * plan, community or membership can ever contribute a live grant. There is a
 * regression test asserting this.
 */

import { planDef, type CommunityPlanKey } from "./communityPlans";

export interface EntitlementFact {
  plan_key: string;
  status: string;
  source: string;
  community_id: string | null;
  expires_at: string | null;
}

export interface MembershipFact {
  community_id: string;
  role: "member" | "leader";
  status: "active" | "suspended" | "removed";
  community_status: "applied" | "approved" | "suspended" | "revoked";
  community_name: string;
  community_slug: string;
}

export interface AccessFacts {
  userId: string;
  isAdmin: boolean;
  entitlements: EntitlementFact[];
  memberships: MembershipFact[];
  now?: Date;
}

export interface ResolvedAccess {
  userId: string;
  isAdmin: boolean;
  /** Paper trading surfaces. */
  paper: boolean;
  /** AI Decision Room. */
  decisionRoom: boolean;
  /** Agentic Command Center. */
  agentic: boolean;
  /** Real-money execution. Admin/owner only, always. */
  live: boolean;
  /** Community Command Center (leader surfaces). */
  leader: boolean;
  planKey: CommunityPlanKey | null;
  communities: Array<{ id: string; name: string; slug: string; role: string }>;
  provenance: string[];
}

function entitlementActive(e: EntitlementFact, now: Date): boolean {
  if (e.status !== "active") return false;
  if (e.expires_at && new Date(e.expires_at).getTime() <= now.getTime()) return false;
  return true;
}

export function resolveAccessFromFacts(facts: AccessFacts): ResolvedAccess {
  const now = facts.now ?? new Date();
  const provenance: string[] = [];

  const active = facts.entitlements.filter((e) => entitlementActive(e, now));
  for (const e of active) provenance.push(`entitlement:${e.plan_key}:${e.source}`);

  const activeMemberships = facts.memberships.filter(
    (m) => m.status === "active" && m.community_status === "approved",
  );

  // Best plan wins across all active entitlements.
  let paper = active.length > 0;
  let decisionRoom = false;
  let agentic = false;
  let planKey: CommunityPlanKey | null = null;

  for (const e of active) {
    const def = planDef(e.plan_key);
    paper = paper || def.paper;
    decisionRoom = decisionRoom || def.decisionRoom;
    agentic = agentic || def.agentic;
    if (!planKey || rank(def.key) > rank(planKey)) planKey = def.key;
  }

  if (facts.isAdmin) {
    provenance.push("role:admin");
    paper = true;
    decisionRoom = true;
    agentic = true;
  }

  const leader =
    facts.isAdmin ||
    facts.memberships.some(
      (m) => m.role === "leader" && m.status === "active" && m.community_status === "approved",
    );
  if (leader) provenance.push("capability:leader");

  // Live is admin-only. Do not add any other term to this expression.
  const live = facts.isAdmin === true;
  if (live) provenance.push("live:owner_admin_role");

  return {
    userId: facts.userId,
    isAdmin: facts.isAdmin,
    paper,
    decisionRoom,
    agentic,
    live,
    leader,
    planKey,
    communities: activeMemberships.map((m) => ({
      id: m.community_id,
      name: m.community_name,
      slug: m.community_slug,
      role: m.role,
    })),
    provenance,
  };
}

const ORDER: CommunityPlanKey[] = ["free_paper_trial", "scout", "agentic", "pro", "fusion"];
function rank(key: CommunityPlanKey): number {
  return ORDER.indexOf(key);
}

export const NO_ACCESS: ResolvedAccess = {
  userId: "",
  isAdmin: false,
  paper: false,
  decisionRoom: false,
  agentic: false,
  live: false,
  leader: false,
  planKey: null,
  communities: [],
  provenance: ["anonymous"],
};
