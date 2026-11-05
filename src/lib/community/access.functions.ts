/**
 * Canonical server authority. Every protected surface calls resolveAccess().
 * No route re-derives eligibility.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  resolveAccessFromFacts,
  type AccessFacts,
  type EntitlementFact,
  type MembershipFact,
  type ResolvedAccess,
} from "./access";

type Rpc = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  from: (t: string) => {
    select: (cols: string) => {
      eq: (c: string, v: unknown) => Promise<{ data: unknown; error: { message: string } | null }>;
    } & Promise<{ data: unknown; error: { message: string } | null }>;
  };
};

export async function isAdminUser(supabase: unknown, userId: string): Promise<boolean> {
  const { data, error } = await (supabase as Rpc).rpc("has_role", {
    _user_id: userId,
    _role: "admin",
  });
  if (error) throw new Error(`admin_check_failed: ${error.message}`);
  return data === true;
}

export async function assertAdmin(supabase: unknown, userId: string): Promise<void> {
  if (!(await isAdminUser(supabase, userId))) {
    throw new Error("Forbidden: admin role required");
  }
}

/** Canonical entry point. `supabase` must be the request-scoped user client. */
export async function resolveAccess(supabase: unknown, userId: string): Promise<ResolvedAccess> {
  const client = supabase as Rpc;
  const isAdmin = await isAdminUser(client, userId);

  const entRes = await client.from("access_entitlements").select("plan_key, status, source, community_id, expires_at").eq("user_id", userId);
  if (entRes.error) throw new Error(`entitlements_read_failed: ${entRes.error.message}`);

  const memRes = await client
    .from("community_memberships")
    .select("community_id, role, status, trading_communities(name, slug, status)") as unknown as Promise<{
      data: unknown; error: { message: string } | null;
    }>;
  const mem = await memRes;
  if (mem.error) throw new Error(`memberships_read_failed: ${mem.error.message}`);

  const memberships: MembershipFact[] = ((mem.data ?? []) as Array<Record<string, unknown>>).map((row) => {
    const c = (row["trading_communities"] ?? {}) as Record<string, unknown>;
    return {
      community_id: String(row["community_id"]),
      role: (row["role"] as MembershipFact["role"]) ?? "member",
      status: (row["status"] as MembershipFact["status"]) ?? "active",
      community_status: (c["status"] as MembershipFact["community_status"]) ?? "applied",
      community_name: (c["name"] as string) ?? "",
      community_slug: (c["slug"] as string) ?? "",
    };
  });

  const facts: AccessFacts = {
    userId,
    isAdmin,
    entitlements: (entRes.data ?? []) as EntitlementFact[],
    memberships,
  };
  return resolveAccessFromFacts(facts);
}

export const getMyAccess = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ResolvedAccess> => {
    return resolveAccess(context.supabase, context.userId);
  });
