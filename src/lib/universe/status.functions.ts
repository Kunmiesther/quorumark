/**
 * Universe status server function — read-only snapshot of the newest
 * `scout_universe_snapshots` row plus current `paper_execution_slots`
 * summary for the caller. Powers the Trade page UniverseStatusCard.
 *
 * Safe for all users: gated by `requireSupabaseAuth`, returns only the
 * caller's own scope.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCapacity, ABSOLUTE_MAX_ENTRY_SYMBOLS } from "./capacity";
import type { PaperSlotState, SlotRow } from "./slots.types";

export interface UniverseStatusPayload {
  flagActive: boolean;
  reason: string;
  snapshotId: string | null;
  generatedAt: string | null;
  expiresAt: string | null;
  ageMs: number | null;
  exchangeSymbolCount: number | null;
  eligibleCount: number | null;
  rankedCount: number | null;
  rejectedCount: number | null;
  topRanked: Array<{ symbol: string; direction: string | null; rank: number | null }>;
  rejectionReasons: Array<{ reason: string; count: number }>;
  capacity: {
    totalSlots: number;
    active: number;
    committed: number;
    reservedForHedge: number;
    reservedForRecovery: number;
    unassigned: number;
    maxNewEntries: number;
    absoluteCeiling: number;
    activeSymbols: string[];
  } | null;
  slots: Array<{
    slotIndex: number;
    state: PaperSlotState;
    assignedSymbol: string | null;
    assignedDirection: "long" | "short" | null;
    label: string;
  }>;
  epoch: {
    runId: string;
    reason: string;
    startedAt: string;
    completedAt: string | null;
  } | null;
}


export const getUniverseStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<UniverseStatusPayload> => {
    const { supabase, userId } = context;
    const flagActive =
      (process.env.DYNAMIC_UNIVERSE_ENABLED === "1" ||
        process.env.DYNAMIC_UNIVERSE_ENABLED?.toLowerCase() === "true");

    const nowIso = new Date().toISOString();
    const snapRes = await supabase
      .from("scout_universe_snapshots")
      .select("id, generated_at, expires_at, exchange_symbol_count, eligible_count, ranked_count, rejected_count")
      .eq("user_id", userId)
      .eq("environment", "paper")
      .eq("market_type", "paper")
      .gt("expires_at", nowIso)
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let topRanked: UniverseStatusPayload["topRanked"] = [];
    let rejectionReasons: UniverseStatusPayload["rejectionReasons"] = [];
    if (snapRes.data) {
      const rankRes = await supabase
        .from("scout_symbol_rankings")
        .select("symbol, direction, rank, bucket, rejection_reasons")
        .eq("snapshot_id", snapRes.data.id)
        .eq("user_id", userId)
        .order("rank", { ascending: true });
      const rows = rankRes.data ?? [];
      topRanked = rows
        .filter((r) => r.bucket === "ranked")
        .slice(0, 10)
        .map((r) => ({
          symbol: r.symbol as string,
          direction: (r.direction as string | null) ?? null,
          rank: (r.rank as number | null) ?? null,
        }));
      const tally = new Map<string, number>();
      for (const r of rows) {
        if (r.bucket === "ranked") continue;
        const reasons = Array.isArray(r.rejection_reasons) ? r.rejection_reasons : [];
        for (const reason of reasons) tally.set(reason, (tally.get(reason) ?? 0) + 1);
      }
      rejectionReasons = Array.from(tally.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([reason, count]) => ({ reason, count }));
    }

    const slotRes = await supabase
      .from("paper_execution_slots")
      .select("id, slot_index, state, assigned_symbol, assigned_direction, position_id, reservation_expires_at")
      .eq("user_id", userId)
      .eq("environment", "paper")
      .eq("market_type", "paper");
    const slots: SlotRow[] = (slotRes.data ?? []).map((r) => ({
      id: r.id as string,
      slotIndex: r.slot_index as number,
      state: r.state as PaperSlotState,
      assignedSymbol: (r.assigned_symbol as string | null) ?? null,
      assignedDirection: (r.assigned_direction as "long" | "short" | null) ?? null,
      positionId: (r.position_id as string | null) ?? null,
      reservationExpiresAt: r.reservation_expires_at
        ? new Date(r.reservation_expires_at as string).getTime()
        : null,
    }));
    const cap = slots.length
      ? resolveCapacity({ slots, capitalCeiling: ABSOLUTE_MAX_ENTRY_SYMBOLS })
      : null;

    const slotView = slots
      .slice()
      .sort((a, b) => a.slotIndex - b.slotIndex)
      .map((s) => {
        let label: string;
        if (s.state === "unassigned") label = "AVAILABLE — WAITING FOR SCOUT";
        else if (s.state === "hedge_reserved") label = "RESERVED · HEDGE";
        else if (s.state === "recovery_reserved") label = "RESERVED · RECOVERY";
        else if (s.state === "reserved") label = `RESERVED · ${s.assignedSymbol ?? ""}`;
        else if (s.state === "committed") label = `COMMITTED · ${s.assignedSymbol ?? ""} ${s.assignedDirection ?? ""}`;
        else label = `ACTIVE · ${s.assignedSymbol ?? ""} ${s.assignedDirection ?? ""}`;
        return {
          slotIndex: s.slotIndex,
          state: s.state,
          assignedSymbol: s.assignedSymbol,
          assignedDirection: s.assignedDirection,
          label,
        };
      });

    const epochRes = await supabase
      .from("paper_epochs")
      .select("run_id, reason, started_at, completed_at")
      .eq("user_id", userId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return {
      flagActive,
      reason: !flagActive
        ? "flag_off"
        : snapRes.data
          ? (cap ? "ok" : "no_slots_initialized")
          : "no_fresh_snapshot",
      snapshotId: snapRes.data?.id ?? null,
      generatedAt: (snapRes.data?.generated_at as string | null) ?? null,
      expiresAt: (snapRes.data?.expires_at as string | null) ?? null,
      ageMs: snapRes.data?.generated_at
        ? Date.now() - new Date(snapRes.data.generated_at as string).getTime()
        : null,
      exchangeSymbolCount: (snapRes.data?.exchange_symbol_count as number | null) ?? null,
      eligibleCount: (snapRes.data?.eligible_count as number | null) ?? null,
      rankedCount: (snapRes.data?.ranked_count as number | null) ?? null,
      rejectedCount: (snapRes.data?.rejected_count as number | null) ?? null,
      topRanked,
      rejectionReasons,
      capacity: cap
        ? {
            totalSlots: cap.totalSlots,
            active: cap.active,
            committed: cap.committed,
            reservedForHedge: cap.reservedForHedge,
            reservedForRecovery: cap.reservedForRecovery,
            unassigned: cap.unassigned,
            maxNewEntries: cap.maxNewEntries,
            absoluteCeiling: ABSOLUTE_MAX_ENTRY_SYMBOLS,
            activeSymbols: cap.activeSymbols,
          }
        : null,
      slots: slotView,
      epoch: epochRes.data
        ? {
            runId: epochRes.data.run_id as string,
            reason: epochRes.data.reason as string,
            startedAt: epochRes.data.started_at as string,
            completedAt: (epochRes.data.completed_at as string | null) ?? null,
          }
        : null,
    };
  });

