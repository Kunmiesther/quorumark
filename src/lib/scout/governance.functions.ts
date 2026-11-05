/**
 * Scout governance — READ-ONLY intelligence surface. Owner/admin only.
 *
 * Proposals are content — schema is versioned via `rules_version`; the
 * database enforces `status` transitions with a CHECK constraint. This
 * server surface only exposes list + propose; approval/rejection happens
 * via admin tooling (out of Stage 2 scope).
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { RULES_VERSION } from "./versions";

import type { Json } from "@/integrations/supabase/types";

const proposeSchema = z.object({
  proposal_key: z.string().min(3).max(120),
  before_rules: z.record(z.unknown()),
  after_rules: z.record(z.unknown()),
  backtest_summary: z.record(z.unknown()),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function assertOwnerOrAdmin(_supabase: any, userId: string): Promise<void> {
  // `has_role` is SECURITY DEFINER, executable only by service_role.
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: isAdmin } = await supabaseAdmin.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (isAdmin === true) return;
  const { data: isOwner } = await supabaseAdmin.rpc("has_role", { _user_id: userId, _role: "owner" as never });
  if (isOwner !== true) throw new Error("forbidden: owner or admin only");
}

export const listRuleProposals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await assertOwnerOrAdmin(supabase, userId);
    const { data, error } = await supabase
      .from("scout_rule_proposals")
      .select("id, proposal_key, status, rules_version, before_rules, after_rules, backtest_summary, created_at, reviewed_at, reviewed_by")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(`list proposals failed: ${error.message}`);
    return data ?? [];
  });

export const createRuleProposal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => proposeSchema.parse(data))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    await assertOwnerOrAdmin(supabase, userId);
    const { data: row, error } = await supabase
      .from("scout_rule_proposals")
      .insert({
        user_id: userId,
        created_by: userId,
        proposal_key: data.proposal_key,
        before_rules: data.before_rules as Json,
        after_rules: data.after_rules as Json,
        backtest_summary: data.backtest_summary as Json,
        status: "proposed",
        rules_version: RULES_VERSION,
      })
      .select("id, proposal_key, status, created_at")
      .single();
    if (error || !row) throw new Error(`propose failed: ${error?.message ?? "unknown"}`);
    return row;
  });
