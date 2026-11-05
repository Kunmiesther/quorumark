/**
 * Engine-facing universe gate.
 *
 * Reads the latest persisted `scout_symbol_rankings` for the newest
 * `scout_universe_snapshots` row (scoped to user+exchange+environment+market)
 * and the current `paper_execution_slots`, then computes which symbols the
 * paper engine may open NEW entries on this tick.
 *
 * Rules (mirroring `decideApprovals` + `resolveCapacity`):
 *   - Flag OFF ⇒ passthrough (active=false, no filtering).
 *   - Retention: symbols with open positions always remain "allowed" for
 *     management (they never appear in the block set), even if their rank
 *     dropped or the snapshot is missing/stale.
 *   - New entries: must appear in the newest snapshot's `ranked` bucket
 *     AND fit within `resolveCapacity(...)` availability.
 *   - Fail-closed: if the ranking snapshot is missing/expired OR the slot
 *     table has no rows for the scope, NEW entries are blocked; open
 *     positions still process for management.
 *
 * This module never writes; it only reads. Persistence of slot lifecycle
 * transitions belongs to `slots.functions.ts` and future execution paths.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { isDynamicUniverseEnabled, type UniverseExecutionMode } from "./flag";
import { resolveCapacity, ABSOLUTE_MAX_ENTRY_SYMBOLS, type CapacitySummary } from "./capacity";
import type { SlotRow, PaperSlotState } from "./slots.types";
import { DEFAULT_PAPER_SYMBOLS } from "@/lib/paper/constants";

/**
 * Authoritative paper universe — always eligible for NEW entries in paper
 * mode, regardless of the dynamic ranker's per-tick output. Guarantees the
 * four internal-test symbols remain available even when the ranker is sparse
 * (e.g. every symbol scored `wait` this tick).
 * Subject to slot capacity and open-position retention like ranked symbols.
 */
const PAPER_AUTHORITATIVE_UNIVERSE: readonly string[] = DEFAULT_PAPER_SYMBOLS;
const PAPER_AUTHORITATIVE_UNIVERSE_SET = new Set<string>(PAPER_AUTHORITATIVE_UNIVERSE);

export interface EngineGateInput {
  supabase: SupabaseClient<Database>;
  userId: string;
  executionMode: UniverseExecutionMode;
  exchange?: string;
  environment?: "paper" | "testnet" | "mainnet";
  marketType?: "paper" | "futures" | "spot";
  openSymbols: readonly string[];
  /** Account equity ceiling / per-slot budget converted upstream. */
  capitalCeiling?: number;
}

export interface EngineGateResult {
  active: boolean;
  reason: string;
  allowedNewEntries: Set<string>;
  retainedSymbols: string[];
  capacity: CapacitySummary | null;
  snapshotId: string | null;
  rankedSymbols: string[];
}

const DEFAULTS = {
  exchange: "apex",
  environment: "paper" as const,
  marketType: "paper" as const,
};

/**
 * Compute the universe gate for a single tick. Cheap, single-read call —
 * safe to invoke once per user tick.
 */
export async function computeUniverseGate(input: EngineGateInput): Promise<EngineGateResult> {
  const openSymbols = Array.from(new Set(input.openSymbols));
  const passthrough = (reason: string): EngineGateResult => ({
    active: false,
    reason,
    allowedNewEntries: new Set<string>(),
    retainedSymbols: openSymbols,
    capacity: null,
    snapshotId: null,
    rankedSymbols: [],
  });

  if (!isDynamicUniverseEnabled({ executionMode: input.executionMode })) {
    return passthrough("flag_off_or_non_paper");
  }

  const exchange = input.exchange ?? DEFAULTS.exchange;
  const environment = input.environment ?? DEFAULTS.environment;
  const marketType = input.marketType ?? DEFAULTS.marketType;

  // 1. Newest non-expired snapshot for scope.
  const nowIso = new Date().toISOString();
  const snapRes = await input.supabase
    .from("scout_universe_snapshots")
    .select("id, generated_at, expires_at")
    .eq("user_id", input.userId)
    .eq("exchange", exchange)
    .eq("environment", environment)
    .eq("market_type", marketType)
    .gt("expires_at", nowIso)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (snapRes.error || !snapRes.data) {
    return {
      active: true,
      reason: snapRes.error ? "snapshot_read_error" : "no_fresh_snapshot",
      allowedNewEntries: new Set<string>(),
      retainedSymbols: openSymbols,
      capacity: null,
      snapshotId: null,
      rankedSymbols: [],
    };
  }
  const snapshotId = snapRes.data.id as string;

  // 2. Rankings for that snapshot.
  const rankRes = await input.supabase
    .from("scout_symbol_rankings")
    .select("symbol, bucket, direction, rank")
    .eq("snapshot_id", snapshotId)
    .eq("user_id", input.userId);
  if (rankRes.error) {
    return {
      active: true,
      reason: "ranking_read_error",
      allowedNewEntries: new Set<string>(),
      retainedSymbols: openSymbols,
      capacity: null,
      snapshotId,
      rankedSymbols: [],
    };
  }
  const rankedRows = (rankRes.data ?? []).filter(
    (r) =>
      r.bucket === "ranked" &&
      (r.direction === "long" || r.direction === "short") &&
      (input.executionMode !== "paper" || PAPER_AUTHORITATIVE_UNIVERSE_SET.has(r.symbol)),
  );
  const rankedSymbols = rankedRows.map((r) => r.symbol as string);

  // 3. Slots for scope.
  const slotRes = await input.supabase
    .from("paper_execution_slots")
    .select(
      "id, slot_index, state, assigned_symbol, assigned_direction, position_id, reservation_expires_at",
    )
    .eq("user_id", input.userId)
    .eq("exchange", exchange)
    .eq("environment", environment)
    .eq("market_type", marketType);
  if (slotRes.error) {
    return {
      active: true,
      reason: "slot_read_error",
      allowedNewEntries: new Set<string>(),
      retainedSymbols: openSymbols,
      capacity: null,
      snapshotId,
      rankedSymbols,
    };
  }
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

  const capacity = resolveCapacity({
    slots,
    capitalCeiling: input.capitalCeiling ?? ABSOLUTE_MAX_ENTRY_SYMBOLS,
  });

  // 4. Compose allowed-new-entries set: ranked ∩ (not open) ∩ within capacity.
  //    In paper mode, seed the authoritative paper universe as a floor so the
  //    pipeline can always trade its provisioned pods even when the dynamic
  //    ranker is sparse this tick (e.g. everything scored `wait`).
  const openSet = new Set(openSymbols);
  type EligibleRow = { symbol: string; rank: number };
  const eligibleBySymbol = new Map<string, EligibleRow>();
  for (const r of rankedRows) {
    if (openSet.has(r.symbol)) continue;
    const rank = (r.rank as number | null) ?? 1e9;
    const existing = eligibleBySymbol.get(r.symbol);
    if (!existing || rank < existing.rank) {
      eligibleBySymbol.set(r.symbol, { symbol: r.symbol, rank });
    }
  }
  if (input.executionMode === "paper") {
    let floorRank = 1e6;
    for (const sym of PAPER_AUTHORITATIVE_UNIVERSE) {
      if (openSet.has(sym)) continue;
      if (!eligibleBySymbol.has(sym)) {
        eligibleBySymbol.set(sym, { symbol: sym, rank: floorRank++ });
      }
    }
  }
  const eligible = Array.from(eligibleBySymbol.values())
    .sort((a, b) => a.rank - b.rank)
    .slice(0, Math.max(0, capacity.maxNewEntries));

  return {
    active: true,
    reason: eligible.length === 0 ? "no_new_capacity_or_no_ranked" : "ok",
    allowedNewEntries: new Set(eligible.map((r) => r.symbol)),
    retainedSymbols: openSymbols,
    capacity,
    snapshotId,
    rankedSymbols,
  };
}
