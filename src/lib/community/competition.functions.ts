import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertAdmin, resolveAccess } from "./access.functions";
import { scoreCompetitionTrades, type ScoredPaperTrade } from "./competition";

type AnyClient = { from: (table: string) => any; rpc: (name: string, args: Record<string, unknown>) => any };

export type CompetitionRow = {
  id: string;
  community_id: string;
  name: string;
  status: "draft" | "enrollment" | "active" | "auditing" | "complete" | "cancelled";
  starts_at: string;
  ends_at: string;
  enrollment_ends_at: string;
  max_participants: number;
  starting_balance: number;
  max_leverage: number;
  max_trade_risk_bps: number;
  max_portfolio_risk_bps: number;
  prize_first_cents: number;
  prize_second_cents: number;
  prize_third_cents: number;
  rules_version: string;
  rules_url: string | null;
  entry_count?: number;
};

export type LeaderboardRow = {
  competition_id: string;
  entry_id: string;
  is_current_user: boolean;
  leaderboard_name: string;
  status: string;
  ending_balance: number | null;
  return_pct: number | null;
  max_drawdown_pct: number | null;
  liquidation_count: number | null;
  closed_trade_count: number | null;
  score: number | null;
  calculated_through: string | null;
};

const createCompetitionInput = z.object({
  communityId: z.string().uuid(),
  name: z.string().trim().min(3).max(120),
  startsAt: z.string().datetime(),
  enrollmentEndsAt: z.string().datetime(),
  rulesUrl: z.string().trim().url().max(2000).nullable().optional(),
});

export const adminCreateCommunityCompetition = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => createCompetitionInput.parse(input))
  .handler(async ({ context, data }) => {
    await assertAdmin(context.supabase, context.userId);
    const start = new Date(data.startsAt);
    const enrollmentEnd = new Date(data.enrollmentEndsAt);
    if (start.getTime() <= Date.now()) throw new Error("Competition start must be in the future.");
    if (enrollmentEnd.getTime() > start.getTime()) throw new Error("Enrollment must close before the start.");
    const end = new Date(start.getTime() + 42 * 86_400_000);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as AnyClient;

    const { data: community, error: communityError } = await admin
      .from("trading_communities")
      .select("id, status")
      .eq("id", data.communityId)
      .single();
    if (communityError || community?.status !== "approved") throw new Error("Choose an approved community.");

    const { data: row, error } = await admin
      .from("community_competitions")
      .insert({
        community_id: data.communityId,
        name: data.name,
        status: "enrollment",
        starts_at: start.toISOString(),
        ends_at: end.toISOString(),
        enrollment_ends_at: enrollmentEnd.toISOString(),
        max_participants: 200,
        starting_balance: 2000,
        max_leverage: 100,
        max_trade_risk_bps: 200,
        max_portfolio_risk_bps: 600,
        prize_first_cents: 30000,
        prize_second_cents: 15000,
        prize_third_cents: 5000,
        rules_version: "1.0",
        rules_url: data.rulesUrl ?? null,
        created_by: context.userId,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    await admin.from("community_audit_events").insert({
      community_id: data.communityId,
      actor_user_id: context.userId,
      action: "competition.created",
      detail: { competition_id: row.id, duration_days: 42, max_participants: 200, prize_pool_cents: 50000 },
    });
    return row as CompetitionRow;
  });

export const adminListCommunityCompetitions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CompetitionRow[]> => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as AnyClient;
    const { data, error } = await admin.from("community_competitions").select("*").order("starts_at", { ascending: false });
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as CompetitionRow[];
    const counts = await Promise.all(rows.map(async (row) => {
      const { count } = await admin.from("community_competition_entries").select("id", { count: "exact", head: true }).eq("competition_id", row.id).in("status", ["active", "completed"]);
      return [row.id, count ?? 0] as const;
    }));
    const byId = new Map(counts);
    return rows.map((row) => ({ ...row, entry_count: byId.get(row.id) ?? 0 }));
  });

export const listMyCommunityCompetitions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { communityId: string }) => z.object({ communityId: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }): Promise<CompetitionRow[]> => {
    const access = await resolveAccess(context.supabase, context.userId);
    if (!access.isAdmin && !access.communities.some((item) => item.id === data.communityId)) throw new Error("Forbidden.");
    const client = context.supabase as unknown as AnyClient;
    const { data: rows, error } = await client.from("community_competitions").select("*").eq("community_id", data.communityId).order("starts_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (rows ?? []) as CompetitionRow[];
  });

export const joinCommunityCompetition = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { competitionId: string; leaderboardName: string; rulesVersion: string }) =>
    z.object({ competitionId: z.string().uuid(), leaderboardName: z.string().trim().min(2).max(40), rulesVersion: z.string().min(1).max(30) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const client = context.supabase as unknown as AnyClient;
    const { data: result, error } = await client.rpc("join_community_competition", {
      _competition_id: data.competitionId,
      _leaderboard_name: data.leaderboardName,
      _accepted_rules_version: data.rulesVersion,
    });
    if (error) throw new Error(error.message);
    return result as { ok: boolean; reason: string; entry_id?: string };
  });

export const listCompetitionLeaderboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { competitionId: string }) => z.object({ competitionId: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }): Promise<LeaderboardRow[]> => {
    const client = context.supabase as unknown as AnyClient;
    const { data: rows, error } = await client.from("community_competition_leaderboard").select("*").eq("competition_id", data.competitionId).order("score", { ascending: false, nullsFirst: false });
    if (error) throw new Error(error.message);
    return (rows ?? []) as LeaderboardRow[];
  });

export const refreshCompetitionScores = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { competitionId: string }) => z.object({ competitionId: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const access = await resolveAccess(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as unknown as AnyClient;
    const { data: competition, error: competitionError } = await admin.from("community_competitions").select("*").eq("id", data.competitionId).single();
    if (competitionError || !competition) throw new Error("Competition not found.");
    const isLeader = access.communities.some((item) => item.id === competition.community_id && item.role === "leader");
    if (!access.isAdmin && !isLeader) throw new Error("Forbidden.");

    const { data: entries, error: entriesError } = await admin.from("community_competition_entries").select("id, user_id, integrity_penalty").eq("competition_id", data.competitionId).in("status", ["active", "completed"]);
    if (entriesError) throw new Error(entriesError.message);
    const through = new Date(Math.min(Date.now(), new Date(competition.ends_at).getTime())).toISOString();

    const snapshots = await Promise.all(((entries ?? []) as Array<{ id: string; user_id: string; integrity_penalty: number }>).map(async (entry) => {
      const { data: trades, error: tradesError } = await admin.from("paper_trades").select("pnl_net, exit_reason, closed_at").eq("user_id", entry.user_id).gte("closed_at", competition.starts_at).lte("closed_at", through).order("closed_at", { ascending: true });
      if (tradesError) throw new Error(tradesError.message);
      const score = scoreCompetitionTrades(Number(competition.starting_balance), (trades ?? []) as ScoredPaperTrade[], Number(entry.integrity_penalty));
      return {
        competition_id: competition.id,
        entry_id: entry.id,
        user_id: entry.user_id,
        ending_balance: score.endingBalance,
        return_pct: score.returnPct,
        max_drawdown_pct: score.maxDrawdownPct,
        liquidation_count: score.liquidationCount,
        closed_trade_count: score.closedTradeCount,
        integrity_penalty: score.integrityPenalty,
        score: score.score,
        calculated_through: through,
      };
    }));

    if (snapshots.length > 0) {
      const { error } = await admin.from("community_competition_score_snapshots").insert(snapshots);
      if (error) throw new Error(error.message);
    }
    return { ok: true, scored: snapshots.length, calculatedThrough: through };
  });
