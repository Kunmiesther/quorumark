/**
 * Community server functions — the only write path for the invite-only model.
 *
 * Authority rules enforced here AND in the database:
 *  - anyone may apply; applications always land as `applied`
 *  - only the Onixus admin approves / suspends / revokes / sets seats & plans
 *  - leaders may create and revoke invitations for their own community only,
 *    bounded by the seat limit
 *  - redemption is atomic in `redeem_community_invitation`
 *  - nothing here can grant live trading
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertAdmin, resolveAccess } from "./access.functions";
import { DEFAULT_PLAN_KEY, isCommunityPlanKey } from "./communityPlans";

export interface CommunityRow {
  id: string;
  slug: string;
  name: string;
  logo_url: string | null;
  status: string;
  plan_key: string;
  seat_limit: number;
  leader_user_id: string | null;
  applicant_email: string;
  created_at: string;
}

export interface InvitationRow {
  id: string;
  community_id: string;
  email: string | null;
  plan_key: string;
  max_uses: number;
  uses: number;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

type AnyClient = {
  from: (t: string) => any;
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

/* ------------------------------------------------------------------ */
/* Public application intake                                           */
/* ------------------------------------------------------------------ */

export const applyForCommunity = createServerFn({ method: "POST" })
  .inputValidator((input: { name: string; slug: string; email: string; note?: string }) => {
    const name = input.name?.trim() ?? "";
    const slug = (input.slug ?? "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const email = (input.email ?? "").trim().toLowerCase();
    if (name.length < 2) throw new Error("Community name is too short.");
    if (slug.length < 2) throw new Error("Community handle is too short.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Enter a valid email address.");
    return { name, slug, email, note: (input.note ?? "").slice(0, 2000) };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await (supabaseAdmin as unknown as AnyClient)
      .from("trading_communities")
      .insert({
        name: data.name,
        slug: data.slug,
        applicant_email: data.email,
        applicant_note: data.note,
        status: "applied",
        seat_limit: 0,
        plan_key: DEFAULT_PLAN_KEY,
      })
      .select("id, slug, status")
      .single();
    if (error) {
      if (String(error.message).includes("duplicate")) {
        throw new Error("That community handle is already taken.");
      }
      throw new Error("Could not submit the application. Please try again.");
    }
    return row as { id: string; slug: string; status: string };
  });

/* ------------------------------------------------------------------ */
/* Admin: Onixus Control Center                                        */
/* ------------------------------------------------------------------ */

export const adminListCommunities = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<Array<CommunityRow & { seats_used: number }>> => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as AnyClient;
    const { data, error } = await admin
      .from("trading_communities")
      .select("id, slug, name, logo_url, status, plan_key, seat_limit, leader_user_id, applicant_email, created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const { data: members } = await admin
      .from("community_memberships")
      .select("community_id, status");
    const used = new Map<string, number>();
    for (const m of (members ?? []) as Array<{ community_id: string; status: string }>) {
      if (m.status === "active") used.set(m.community_id, (used.get(m.community_id) ?? 0) + 1);
    }
    return ((data ?? []) as CommunityRow[]).map((c) => ({ ...c, seats_used: used.get(c.id) ?? 0 }));
  });

export const adminUpdateCommunity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: {
    communityId: string;
    status?: "applied" | "approved" | "suspended" | "revoked";
    seatLimit?: number;
    planKey?: string;
    leaderUserId?: string | null;
  }) => {
    if (!input.communityId) throw new Error("communityId is required");
    if (input.seatLimit != null && (input.seatLimit < 0 || input.seatLimit > 100000)) {
      throw new Error("Seat limit out of range");
    }
    if (input.planKey && !isCommunityPlanKey(input.planKey)) throw new Error("Unknown plan");
    return input;
  })
  .handler(async ({ context, data }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as AnyClient;

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (data.status) {
      patch["status"] = data.status;
      if (data.status === "approved") {
        patch["approved_by"] = context.userId;
        patch["approved_at"] = new Date().toISOString();
      }
    }
    if (data.seatLimit != null) patch["seat_limit"] = data.seatLimit;
    if (data.planKey) patch["plan_key"] = data.planKey;
    if (data.leaderUserId !== undefined) patch["leader_user_id"] = data.leaderUserId;

    const { error } = await admin.from("trading_communities").update(patch).eq("id", data.communityId);
    if (error) throw new Error(error.message);

    if (data.leaderUserId) {
      await admin.from("community_memberships").upsert(
        { community_id: data.communityId, user_id: data.leaderUserId, role: "leader", status: "active" },
        { onConflict: "community_id,user_id" },
      );
    }

    await admin.from("community_audit_events").insert({
      community_id: data.communityId,
      actor_user_id: context.userId,
      action: "community.updated",
      detail: patch,
    });
    return { ok: true };
  });

/* ------------------------------------------------------------------ */
/* Leader: invitations                                                 */
/* ------------------------------------------------------------------ */

export const createInvitation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { communityId: string; email?: string | null; maxUses?: number; expiresInDays?: number }) => {
    if (!input.communityId) throw new Error("communityId is required");
    const maxUses = Math.max(1, Math.min(input.maxUses ?? 1, 500));
    const expiresInDays = Math.max(1, Math.min(input.expiresInDays ?? 14, 90));
    const email = input.email ? input.email.trim().toLowerCase() : null;
    return { communityId: input.communityId, email, maxUses, expiresInDays };
  })
  .handler(async ({ context, data }) => {
    const access = await resolveAccess(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as AnyClient;

    const { data: community, error: cErr } = await admin
      .from("trading_communities")
      .select("id, status, seat_limit, plan_key, leader_user_id")
      .eq("id", data.communityId)
      .single();
    if (cErr || !community) throw new Error("Community not found.");

    const isLeaderHere =
      community.leader_user_id === context.userId ||
      access.communities.some((c) => c.id === data.communityId && c.role === "leader");
    if (!access.isAdmin && !isLeaderHere) throw new Error("Forbidden: not a leader of this community.");
    if (community.status !== "approved") throw new Error("This community is not active.");

    // Seat bound: active members + outstanding unredeemed uses must fit the limit.
    const { data: members } = await admin
      .from("community_memberships")
      .select("id, status")
      .eq("community_id", data.communityId);
    const seatsUsed = ((members ?? []) as Array<{ status: string }>).filter((m) => m.status === "active").length;

    const { data: invs } = await admin
      .from("community_invitations")
      .select("max_uses, uses, revoked_at, expires_at")
      .eq("community_id", data.communityId);
    const nowIso = Date.now();
    const outstanding = ((invs ?? []) as Array<{ max_uses: number; uses: number; revoked_at: string | null; expires_at: string }>)
      .filter((i) => !i.revoked_at && new Date(i.expires_at).getTime() > nowIso)
      .reduce((sum, i) => sum + Math.max(0, i.max_uses - i.uses), 0);

    if (seatsUsed + outstanding + data.maxUses > community.seat_limit) {
      throw new Error(
        `Seat limit reached: ${seatsUsed} used, ${outstanding} outstanding, limit ${community.seat_limit}.`,
      );
    }

    const token = randomToken();
    const token_hash = await hashToken(token);
    const expires_at = new Date(Date.now() + data.expiresInDays * 86400_000).toISOString();

    const { data: row, error } = await admin
      .from("community_invitations")
      .insert({
        community_id: data.communityId,
        token_hash,
        email: data.email,
        plan_key: community.plan_key,
        max_uses: data.maxUses,
        expires_at,
        created_by: context.userId,
      })
      .select("id, community_id, email, plan_key, max_uses, uses, expires_at, revoked_at, created_at")
      .single();
    if (error) throw new Error(error.message);

    await admin.from("community_audit_events").insert({
      community_id: data.communityId,
      actor_user_id: context.userId,
      action: "invitation.created",
      detail: { invitation_id: row.id, max_uses: data.maxUses, expires_at },
    });

    // The plaintext token is returned exactly once and never persisted.
    return { invitation: row as InvitationRow, token };
  });

export const revokeInvitation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { invitationId: string }) => {
    if (!input.invitationId) throw new Error("invitationId is required");
    return input;
  })
  .handler(async ({ context, data }) => {
    const access = await resolveAccess(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as AnyClient;

    const { data: inv, error } = await admin
      .from("community_invitations")
      .select("id, community_id")
      .eq("id", data.invitationId)
      .single();
    if (error || !inv) throw new Error("Invitation not found.");

    const isLeaderHere = access.communities.some((c) => c.id === inv.community_id && c.role === "leader");
    if (!access.isAdmin && !isLeaderHere) throw new Error("Forbidden: not a leader of this community.");

    await admin
      .from("community_invitations")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", data.invitationId);
    await admin.from("community_audit_events").insert({
      community_id: inv.community_id,
      actor_user_id: context.userId,
      action: "invitation.revoked",
      detail: { invitation_id: data.invitationId },
    });
    return { ok: true };
  });

export const listCommunityInvitations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { communityId: string }) => input)
  .handler(async ({ context, data }): Promise<InvitationRow[]> => {
    const access = await resolveAccess(context.supabase, context.userId);
    const isLeaderHere = access.communities.some((c) => c.id === data.communityId && c.role === "leader");
    if (!access.isAdmin && !isLeaderHere) throw new Error("Forbidden.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await (supabaseAdmin as unknown as AnyClient)
      .from("community_invitations")
      .select("id, community_id, email, plan_key, max_uses, uses, expires_at, revoked_at, created_at")
      .eq("community_id", data.communityId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (rows ?? []) as InvitationRow[];
  });

/* ------------------------------------------------------------------ */
/* Invitation preview + redemption                                     */
/* ------------------------------------------------------------------ */

export const previewInvitation = createServerFn({ method: "POST" })
  .inputValidator((input: { token: string }) => {
    if (!input.token || input.token.length < 16) throw new Error("Invalid invitation link.");
    return input;
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as AnyClient;
    const token_hash = await hashToken(data.token);
    const { data: inv } = await admin
      .from("community_invitations")
      .select("id, community_id, email, plan_key, max_uses, uses, expires_at, revoked_at")
      .eq("token_hash", token_hash)
      .maybeSingle();
    if (!inv) return { ok: false as const, reason: "INVITE_NOT_FOUND" };

    const { data: community } = await admin
      .from("trading_communities")
      .select("id, name, slug, logo_url, status, seat_limit")
      .eq("id", inv.community_id)
      .maybeSingle();
    if (!community) return { ok: false as const, reason: "INVITE_NOT_FOUND" };

    let reason: string | null = null;
    if (inv.revoked_at) reason = "INVITE_REVOKED";
    else if (new Date(inv.expires_at).getTime() <= Date.now()) reason = "INVITE_EXPIRED";
    else if (inv.uses >= inv.max_uses) reason = "INVITE_EXHAUSTED";
    else if (community.status !== "approved") reason = "COMMUNITY_NOT_ACTIVE";

    return {
      ok: reason === null,
      reason,
      community: {
        name: community.name,
        slug: community.slug,
        logo_url: community.logo_url as string | null,
      },
      plan_key: inv.plan_key as string,
      expires_at: inv.expires_at as string,
      email_locked: Boolean(inv.email),
    };
  });

export const redeemInvitation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { token: string }) => {
    if (!input.token || input.token.length < 16) throw new Error("Invalid invitation link.");
    return input;
  })
  .handler(async ({ context, data }) => {
    const token_hash = await hashToken(data.token);
    const client = context.supabase as unknown as AnyClient;
    const email = (context.claims as Record<string, unknown> | undefined)?.["email"] as string | undefined;

    const { data: result, error } = await client.rpc("redeem_community_invitation", {
      _token_hash: token_hash,
      _email: email ?? null,
    });
    if (error) throw new Error(error.message);
    const out = result as { ok: boolean; reason: string; community_id?: string; plan_key?: string };

    if (out.ok) {
      // Canonical paper provisioning — same routine every account uses.
      await client.rpc("my_ensure_paper_ready", {});
    }
    return out;
  });

/* ------------------------------------------------------------------ */
/* Leader dashboard data                                               */
/* ------------------------------------------------------------------ */

/** Aggregates below this cohort size are suppressed so a leader cannot
 * deanonymize a single member's results. */
export const MIN_COHORT = 5;

export const getLeaderDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { communityId: string }) => input)
  .handler(async ({ context, data }) => {
    const access = await resolveAccess(context.supabase, context.userId);
    const isLeaderHere = access.communities.some((c) => c.id === data.communityId && c.role === "leader");
    if (!access.isAdmin && !isLeaderHere) throw new Error("Forbidden.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as AnyClient;

    const [{ data: community }, { data: members }, { data: invs }, { data: ledger }, { data: audit }] =
      await Promise.all([
        admin.from("trading_communities").select("id, name, slug, logo_url, status, plan_key, seat_limit").eq("id", data.communityId).single(),
        admin.from("community_memberships").select("user_id, status, joined_at").eq("community_id", data.communityId),
        admin.from("community_invitations").select("id, uses, max_uses, revoked_at, expires_at").eq("community_id", data.communityId),
        admin.from("community_commission_ledger").select("id, period_start, period_end, amount_cents, currency, source").eq("community_id", data.communityId).order("period_start", { ascending: false }),
        admin.from("community_audit_events").select("id, action, detail, created_at").eq("community_id", data.communityId).order("created_at", { ascending: false }).limit(50),
      ]);

    const memberRows = (members ?? []) as Array<{ user_id: string; status: string; joined_at: string }>;
    const activeMembers = memberRows.filter((m) => m.status === "active");
    const invRows = (invs ?? []) as Array<{ uses: number; max_uses: number; revoked_at: string | null; expires_at: string }>;

    const cohortTooSmall = activeMembers.length < MIN_COHORT;

    return {
      community,
      funnel: {
        invitesCreated: invRows.reduce((s, i) => s + i.max_uses, 0),
        invitesRedeemed: invRows.reduce((s, i) => s + i.uses, 0),
        invitesOutstanding: invRows
          .filter((i) => !i.revoked_at && new Date(i.expires_at).getTime() > Date.now())
          .reduce((s, i) => s + Math.max(0, i.max_uses - i.uses), 0),
        seatsUsed: activeMembers.length,
        seatLimit: (community as { seat_limit?: number } | null)?.seat_limit ?? 0,
      },
      cohortTooSmall,
      minCohort: MIN_COHORT,
      ledger: ledger ?? [],
      audit: audit ?? [],
    };
  });
