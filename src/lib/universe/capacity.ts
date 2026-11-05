/**
 * Capacity resolver.
 *
 * Derives the actual number of new-entry symbols the engine may activate
 * from real state:
 *
 *   maxEntry  = min(absolute_ceiling, unassigned_slots,
 *                   capital_floor_slots, stricter_risk_limits)
 *   reserved  = slots held for hedge/recovery + already-active positions
 *
 * Fail-closed rules:
 *   - If no slot rows exist for the scope yet, capacity is 0. The engine
 *     must initialize slots explicitly (see `slots.functions.ts`).
 *   - Hedge/recovery reserved slots are never counted as available for new
 *     entries.
 *   - Currently active symbols keep their slot (retention >> re-ranking).
 */
import type { PaperSlotState, SlotRow } from "./slots.types";

export const ABSOLUTE_MAX_ENTRY_SYMBOLS = 10;

export interface CapacityInputs {
  slots: readonly SlotRow[];
  /**
   * Hard capital-derived ceiling. Callers compute this from account equity /
   * per-slot budget upstream; the resolver caps against it.
   */
  capitalCeiling: number;
  /**
   * Additional stricter risk limits from existing kill-switch / exposure
   * guards. Optional; defaults to Infinity (no additional cap).
   */
  strictLimit?: number;
  /**
   * Reserve `hedgeReserveCount` slots as hedge_reserved and
   * `recoveryReserveCount` slots as recovery_reserved. These are never
   * counted as available for new entries.
   */
  hedgeReserveCount?: number;
  recoveryReserveCount?: number;
}

export interface CapacitySummary {
  totalSlots: number;
  activeSymbols: string[];
  reservedForHedge: number;
  reservedForRecovery: number;
  committed: number;
  active: number;
  unassigned: number;
  /** Slots available to fill with newly-ranked entries. */
  availableForEntry: number;
  /** Absolute ceiling after all limits, ≤ ABSOLUTE_MAX_ENTRY_SYMBOLS. */
  maxNewEntries: number;
  /** Machine-readable notes for the UI. */
  notes: string[];
}

const ACTIVE_STATES: PaperSlotState[] = ["active", "committed"];
const CONSUMING_STATES: PaperSlotState[] = [
  "reserved",
  "committed",
  "active",
  "hedge_reserved",
  "recovery_reserved",
];

export function resolveCapacity(inputs: CapacityInputs): CapacitySummary {
  const {
    slots,
    capitalCeiling,
    strictLimit = Number.POSITIVE_INFINITY,
    hedgeReserveCount = 1,
    recoveryReserveCount = 1,
  } = inputs;
  const notes: string[] = [];

  const totalSlots = Math.min(slots.length, ABSOLUTE_MAX_ENTRY_SYMBOLS);
  if (slots.length === 0) {
    notes.push("no_slots_initialized");
  }
  if (slots.length > ABSOLUTE_MAX_ENTRY_SYMBOLS) {
    notes.push("slot_count_exceeds_ceiling_truncated");
  }

  const activeSymbols: string[] = [];
  let reservedForHedge = 0;
  let reservedForRecovery = 0;
  let committed = 0;
  let active = 0;
  let unassigned = 0;

  for (const s of slots) {
    if (s.state === "hedge_reserved") reservedForHedge += 1;
    else if (s.state === "recovery_reserved") reservedForRecovery += 1;
    else if (s.state === "committed") committed += 1;
    else if (s.state === "active") active += 1;
    else if (s.state === "unassigned") unassigned += 1;
    if (ACTIVE_STATES.includes(s.state) && s.assignedSymbol) {
      activeSymbols.push(s.assignedSymbol);
    }
  }

  // Reserve target: at least hedgeReserveCount + recoveryReserveCount slots must
  // remain non-entry-consuming. If we're short, we don't retroactively evict
  // active/committed positions — we just shrink available entry capacity.
  const desiredReserve = hedgeReserveCount + recoveryReserveCount;
  const currentReserve = reservedForHedge + reservedForRecovery;
  const reserveShortfall = Math.max(0, desiredReserve - currentReserve);
  if (reserveShortfall > 0) notes.push("hedge_or_recovery_reserve_short");

  const consuming = slots.filter((s) => CONSUMING_STATES.includes(s.state)).length;
  const rawAvailable = Math.max(0, totalSlots - consuming - reserveShortfall);

  const capitalCap = Math.max(0, Math.floor(capitalCeiling));
  const strictCap = Number.isFinite(strictLimit) ? Math.max(0, Math.floor(strictLimit)) : rawAvailable;

  const maxNewEntries = Math.min(rawAvailable, capitalCap, strictCap, ABSOLUTE_MAX_ENTRY_SYMBOLS);
  if (maxNewEntries < rawAvailable && capitalCap < rawAvailable) notes.push("capped_by_capital");
  if (maxNewEntries < rawAvailable && strictCap < rawAvailable) notes.push("capped_by_strict_limit");

  return {
    totalSlots,
    activeSymbols,
    reservedForHedge,
    reservedForRecovery,
    committed,
    active,
    unassigned,
    availableForEntry: rawAvailable,
    maxNewEntries,
    notes,
  };
}
