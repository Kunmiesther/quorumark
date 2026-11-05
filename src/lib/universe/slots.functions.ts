/**
 * Slot lifecycle server functions.
 *
 * Endpoints:
 *   - listSlots           — owner-scoped read for the UI / capacity resolver.
 *   - ensureSlots         — idempotent seeder for a scope (creates any of the
 *                           10 slot indices that don't yet exist as 'unassigned').
 *   - reconcileSlots      — cross-reference persisted positions and repair
 *                           slot rows whose position_id no longer maps to an
 *                           open position. Never evicts an active position.
 *
 * All flow through `requireSupabaseAuth` so the caller is the RLS-owner.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SlotRow } from "./slots.types";
import type { UniverseEnvironment, UniverseMarketType } from "./types";

const ABSOLUTE_MAX_SLOTS = 10;

interface ScopeInput {
  exchange: string;
  environment: UniverseEnvironment;
  marketType: UniverseMarketType;
  connectionId?: string | null;
}

function normalizeScope(input: ScopeInput): ScopeInput {
  if (!input?.exchange) throw new Error("exchange required");
  if (!input.environment) throw new Error("environment required");
  if (!input.marketType) throw new Error("marketType required");
  return input;
}

function rowToSlot(r: {
  id: unknown; slot_index: unknown; state: unknown;
  assigned_symbol: unknown; assigned_direction: unknown;
  position_id: unknown; reservation_expires_at: unknown;
}): SlotRow {
  return {
    id: r.id as string,
    slotIndex: Number(r.slot_index),
    state: r.state as SlotRow["state"],
    assignedSymbol: (r.assigned_symbol as string | null) ?? null,
    assignedDirection: (r.assigned_direction as "long" | "short" | null) ?? null,
    positionId: (r.position_id as string | null) ?? null,
    reservationExpiresAt: r.reservation_expires_at
      ? new Date(r.reservation_expires_at as string).getTime()
      : null,
  };
}

export const listSlots = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: ScopeInput) => normalizeScope(input))
  .handler(async ({ data, context }): Promise<SlotRow[]> => {
    const { supabase, userId } = context;
    const { data: rows, error } = await supabase
      .from("paper_execution_slots")
      .select("id,slot_index,state,assigned_symbol,assigned_direction,position_id,reservation_expires_at")
      .eq("user_id", userId)
      .eq("exchange", data.exchange)
      .eq("environment", data.environment)
      .eq("market_type", data.marketType)
      .order("slot_index", { ascending: true });
    if (error) throw new Error(`listSlots failed: ${error.message}`);
    return (rows ?? []).map(rowToSlot);
  });

export const ensureSlots = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: ScopeInput) => normalizeScope(input))
  .handler(async ({ data, context }): Promise<SlotRow[]> => {
    const { supabase, userId } = context;
    const { data: existingRows } = await supabase
      .from("paper_execution_slots")
      .select("slot_index")
      .eq("user_id", userId)
      .eq("exchange", data.exchange)
      .eq("environment", data.environment)
      .eq("market_type", data.marketType);
    const existing = new Set((existingRows ?? []).map((r) => Number(r.slot_index)));
    const toInsert: Array<{
      user_id: string;
      connection_id: string | null;
      exchange: string;
      environment: UniverseEnvironment;
      market_type: UniverseMarketType;
      slot_index: number;
    }> = [];
    for (let i = 1; i <= ABSOLUTE_MAX_SLOTS; i += 1) {
      if (existing.has(i)) continue;
      toInsert.push({
        user_id: userId,
        connection_id: data.connectionId ?? null,
        exchange: data.exchange,
        environment: data.environment,
        market_type: data.marketType,
        slot_index: i,
      });
    }
    if (toInsert.length > 0) {
      const { error } = await supabase.from("paper_execution_slots").insert(toInsert);
      if (error) throw new Error(`ensureSlots insert failed: ${error.message}`);
    }
    const { data: rows } = await supabase
      .from("paper_execution_slots")
      .select("id,slot_index,state,assigned_symbol,assigned_direction,position_id,reservation_expires_at")
      .eq("user_id", userId)
      .eq("exchange", data.exchange)
      .eq("environment", data.environment)
      .eq("market_type", data.marketType)
      .order("slot_index", { ascending: true });
    return (rows ?? []).map(rowToSlot);
  });

/**
 * Reconcile: if a slot references a position_id that no longer exists or is
 * closed, drop the slot back to 'unassigned'. Never touches slots whose
 * position is still open — active positions are sacred.
 */
export const reconcileSlots = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: ScopeInput) => normalizeScope(input))
  .handler(async ({ data, context }): Promise<{ reconciled: number }> => {
    const { supabase, userId } = context;
    const { data: slots } = await supabase
      .from("paper_execution_slots")
      .select("id,state,position_id")
      .eq("user_id", userId)
      .eq("exchange", data.exchange)
      .eq("environment", data.environment)
      .eq("market_type", data.marketType)
      .not("position_id", "is", null);
    let reconciled = 0;
    for (const s of slots ?? []) {
      if (!s.position_id) continue;
      const { data: pos } = await supabase
        .from("paper_positions")
        .select("status")
        .eq("id", s.position_id as string)
        .eq("user_id", userId)
        .maybeSingle();
      const openStates = ["open"];
      if (!pos || !openStates.includes(pos.status as string)) {
        await supabase
          .from("paper_execution_slots")
          .update({
            state: "unassigned",
            assigned_symbol: null,
            assigned_direction: null,
            position_id: null,
            reservation_expires_at: null,
          })
          .eq("id", s.id as string)
          .eq("user_id", userId);
        reconciled += 1;
      }
    }
    return { reconciled };
  });
