/**
 * Canonical access authority — pure resolution tests.
 *
 * The critical assertion here is the live invariant: NO entitlement, plan,
 * community, membership or leader capability may ever produce live = true.
 */
import { describe, it, expect } from "vitest";
import { resolveAccessFromFacts, type AccessFacts, type EntitlementFact } from "../access";
import { COMMUNITY_PLANS } from "../communityPlans";

function facts(over: Partial<AccessFacts> = {}): AccessFacts {
  return { userId: "u1", isAdmin: false, entitlements: [], memberships: [], ...over };
}
function ent(plan_key: string, over: Partial<EntitlementFact> = {}): EntitlementFact {
  return { plan_key, status: "active", source: "invitation", community_id: null, expires_at: null, ...over };
}

describe("resolveAccessFromFacts", () => {
  it("denies everything to a signed-in user with no entitlement", () => {
    const a = resolveAccessFromFacts(facts());
    expect(a.paper).toBe(false);
    expect(a.decisionRoom).toBe(false);
    expect(a.agentic).toBe(false);
    expect(a.live).toBe(false);
    expect(a.leader).toBe(false);
  });

  it("grants paper only for the free paper trial", () => {
    const a = resolveAccessFromFacts(facts({ entitlements: [ent("free_paper_trial", { source: "grandfathered" })] }));
    expect(a.paper).toBe(true);
    expect(a.decisionRoom).toBe(false);
    expect(a.agentic).toBe(false);
    expect(a.live).toBe(false);
    expect(a.planKey).toBe("free_paper_trial");
    expect(a.provenance).toContain("entitlement:free_paper_trial:grandfathered");
  });

  it("grants the decision room on scout and agentic tools on agentic", () => {
    expect(resolveAccessFromFacts(facts({ entitlements: [ent("scout")] })).decisionRoom).toBe(true);
    expect(resolveAccessFromFacts(facts({ entitlements: [ent("scout")] })).agentic).toBe(false);
    expect(resolveAccessFromFacts(facts({ entitlements: [ent("agentic")] })).agentic).toBe(true);
  });

  it("ignores revoked and expired entitlements", () => {
    const now = new Date("2026-01-10T00:00:00Z");
    expect(resolveAccessFromFacts(facts({ entitlements: [ent("pro", { status: "revoked" })], now })).paper).toBe(false);
    expect(
      resolveAccessFromFacts(facts({ entitlements: [ent("pro", { expires_at: "2026-01-01T00:00:00Z" })], now })).paper,
    ).toBe(false);
  });

  it("takes the highest plan when several entitlements are active", () => {
    const a = resolveAccessFromFacts(facts({ entitlements: [ent("free_paper_trial"), ent("agentic")] }));
    expect(a.planKey).toBe("agentic");
  });

  // ---- THE LIVE INVARIANT ----
  it("never grants live from ANY entitlement plan", () => {
    for (const plan of Object.values(COMMUNITY_PLANS)) {
      const a = resolveAccessFromFacts(facts({ entitlements: [ent(plan.key)] }));
      expect(a.live, `plan ${plan.key} must not grant live`).toBe(false);
    }
  });

  it("never grants live from leadership or membership", () => {
    const a = resolveAccessFromFacts(
      facts({
        entitlements: [ent("fusion")],
        memberships: [
          {
            community_id: "c1",
            role: "leader",
            status: "active",
            community_status: "approved",
            community_name: "Example",
            community_slug: "example",
          },
        ],
      }),
    );
    expect(a.leader).toBe(true);
    expect(a.live).toBe(false);
  });

  it("grants live only to the admin/owner role", () => {
    const a = resolveAccessFromFacts(facts({ isAdmin: true }));
    expect(a.live).toBe(true);
    expect(a.paper).toBe(true);
    expect(a.provenance).toContain("live:owner_admin_role");
  });

  it("does not surface suspended communities or suspended memberships", () => {
    const a = resolveAccessFromFacts(
      facts({
        entitlements: [ent("scout")],
        memberships: [
          { community_id: "c1", role: "member", status: "active", community_status: "suspended", community_name: "S", community_slug: "s" },
          { community_id: "c2", role: "leader", status: "suspended", community_status: "approved", community_name: "T", community_slug: "t" },
        ],
      }),
    );
    expect(a.communities).toHaveLength(0);
    expect(a.leader).toBe(false);
  });
});
