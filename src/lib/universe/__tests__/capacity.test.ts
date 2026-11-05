import { describe, it, expect } from "vitest";
import { ABSOLUTE_MAX_ENTRY_SYMBOLS, resolveCapacity } from "../capacity";
import type { SlotRow } from "../slots.types";

function slot(idx: number, state: SlotRow["state"], symbol: string | null = null): SlotRow {
  return {
    id: `s${idx}`, slotIndex: idx, state,
    assignedSymbol: symbol,
    assignedDirection: symbol ? "long" : null,
    positionId: null,
    reservationExpiresAt: null,
  };
}

describe("capacity resolver", () => {
  it("returns 0 when no slots initialized (fail-closed)", () => {
    const s = resolveCapacity({ slots: [], capitalCeiling: 10 });
    expect(s.maxNewEntries).toBe(0);
    expect(s.notes).toContain("no_slots_initialized");
  });

  it("caps absolute max at 10 even if slots list is longer", () => {
    const slots = Array.from({ length: 15 }, (_, i) => slot(i + 1, "unassigned"));
    const s = resolveCapacity({ slots, capitalCeiling: 100 });
    expect(s.totalSlots).toBe(10);
    expect(s.maxNewEntries).toBeLessThanOrEqual(ABSOLUTE_MAX_ENTRY_SYMBOLS);
  });

  it("subtracts hedge and recovery reserves from available entries", () => {
    const slots = Array.from({ length: 10 }, (_, i) => slot(i + 1, "unassigned"));
    // Zero currently reserved — desired hedge=1, recovery=1 → shortfall 2.
    const s = resolveCapacity({ slots, capitalCeiling: 100 });
    expect(s.notes).toContain("hedge_or_recovery_reserve_short");
    expect(s.maxNewEntries).toBe(10 - 2);
  });

  it("does not evict active positions when reserve is short", () => {
    const slots = [
      slot(1, "active", "BTC-USDT"),
      slot(2, "active", "ETH-USDT"),
      ...Array.from({ length: 8 }, (_, i) => slot(i + 3, "unassigned")),
    ];
    const s = resolveCapacity({ slots, capitalCeiling: 100 });
    expect(s.activeSymbols).toEqual(["BTC-USDT", "ETH-USDT"]);
    // 10 total - 2 active - 2 desired-reserve-shortfall = 6 available
    expect(s.maxNewEntries).toBe(6);
  });

  it("capital cap wins when lower than slot capacity", () => {
    const slots = Array.from({ length: 10 }, (_, i) => slot(i + 1, "unassigned"));
    const s = resolveCapacity({ slots, capitalCeiling: 3, hedgeReserveCount: 0, recoveryReserveCount: 0 });
    expect(s.maxNewEntries).toBe(3);
    expect(s.notes).toContain("capped_by_capital");
  });

  it("strict risk limit wins when lower", () => {
    const slots = Array.from({ length: 10 }, (_, i) => slot(i + 1, "unassigned"));
    const s = resolveCapacity({
      slots, capitalCeiling: 100, strictLimit: 2,
      hedgeReserveCount: 0, recoveryReserveCount: 0,
    });
    expect(s.maxNewEntries).toBe(2);
    expect(s.notes).toContain("capped_by_strict_limit");
  });

  it("counts hedge_reserved and recovery_reserved slots as consumed", () => {
    const slots = [
      slot(1, "hedge_reserved", "BTC-USDT"),
      slot(2, "recovery_reserved", "ETH-USDT"),
      ...Array.from({ length: 8 }, (_, i) => slot(i + 3, "unassigned")),
    ];
    const s = resolveCapacity({ slots, capitalCeiling: 100 });
    expect(s.reservedForHedge).toBe(1);
    expect(s.reservedForRecovery).toBe(1);
    // Reserve is met exactly (1+1) — no shortfall — available = 10-2 = 8.
    expect(s.maxNewEntries).toBe(8);
    expect(s.notes).not.toContain("hedge_or_recovery_reserve_short");
  });
});
