import { describe, it, expect } from "vitest";
import { TickAllocator, type AllocatorInputs } from "../allocator";

function baseInputs(overrides: Partial<AllocatorInputs> = {}): AllocatorInputs {
  return {
    maxNewEntries: 3,
    activeSymbols: [],
    wallets: [
      { walletKey: "slot-1", balance: 1000, occupied: false },
      { walletKey: "slot-2", balance: 1000, occupied: false },
      { walletKey: "slot-3", balance: 1000, occupied: false },
      { walletKey: "slot-4", balance: 5, occupied: false },
    ],
    openPositions: [],
    allowedNewEntries: new Set(["BTC-USDT", "ETH-USDT", "SOL-USDT", "ADA-USDT"]),
    ...overrides,
  };
}

describe("TickAllocator", () => {
  it("reserves a free wallet and consumes a new-entry slot", () => {
    const a = new TickAllocator(baseInputs());
    const r = a.tryReserve({ symbol: "BTC-USDT", direction: "long", requiredMargin: 100 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.consumedNewEntry).toBe(true);
      expect(a.remainingNewEntries).toBe(2);
    }
  });

  it("blocks a second reservation on the same (symbol, direction)", () => {
    const a = new TickAllocator(baseInputs());
    a.tryReserve({ symbol: "BTC-USDT", direction: "long", requiredMargin: 100, preferredWalletKey: "slot-1" });
    const dup = a.tryReserve({ symbol: "BTC-USDT", direction: "long", requiredMargin: 100, preferredWalletKey: "slot-2" });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toBe("duplicate_symbol_direction");
  });

  it("allows the opposite direction as a hedge on the same symbol without extra capacity cost", () => {
    const a = new TickAllocator(baseInputs());
    const r1 = a.tryReserve({ symbol: "BTC-USDT", direction: "long", requiredMargin: 100 });
    const r2 = a.tryReserve({ symbol: "BTC-USDT", direction: "short", requiredMargin: 100, allowHedge: true });
    expect(r1.ok && r2.ok).toBe(true);
    // Two legs on the same symbol still consume only one capacity slot.
    expect(a.remainingNewEntries).toBe(2);
  });

  it("allows one role wallet to hold different symbols", () => {
    const a = new TickAllocator(baseInputs());
    a.tryReserve({ symbol: "BTC-USDT", direction: "long", requiredMargin: 100, preferredWalletKey: "slot-1" });
    const conflict = a.tryReserve({ symbol: "ETH-USDT", direction: "long", requiredMargin: 100, preferredWalletKey: "slot-1" });
    expect(conflict.ok).toBe(true);
  });

  it("respects universe gate for new symbols but allows retention", () => {
    const a = new TickAllocator(baseInputs({
      allowedNewEntries: new Set(["BTC-USDT"]),
      activeSymbols: ["ETH-USDT"],
      openPositions: [{ symbol: "ETH-USDT", direction: "long", walletKey: "slot-1" }],
      wallets: [
        { walletKey: "slot-1", balance: 1000, occupied: true },
        { walletKey: "slot-2", balance: 1000, occupied: false },
      ],
    }));
    // ETH short (opposing hedge on retained active symbol) — allowed, no capacity cost.
    const hedge = a.tryReserve({ symbol: "ETH-USDT", direction: "short", requiredMargin: 100, preferredWalletKey: "slot-2", allowHedge: true });
    expect(hedge.ok).toBe(true);
    // SOL — not in allow-list, not active → blocked.
    const blocked = a.tryReserve({ symbol: "SOL-USDT", direction: "long", requiredMargin: 100 });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe("not_in_universe");
  });

  it("caps new-entry throughput at maxNewEntries", () => {
    const a = new TickAllocator(baseInputs({ maxNewEntries: 2 }));
    expect(a.tryReserve({ symbol: "BTC-USDT", direction: "long", requiredMargin: 100 }).ok).toBe(true);
    expect(a.tryReserve({ symbol: "ETH-USDT", direction: "long", requiredMargin: 100 }).ok).toBe(true);
    const over = a.tryReserve({ symbol: "SOL-USDT", direction: "long", requiredMargin: 100 });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toBe("no_new_entry_capacity");
  });

  it("rejects when preferred wallet lacks balance", () => {
    const a = new TickAllocator(baseInputs());
    const r = a.tryReserve({ symbol: "BTC-USDT", direction: "long", requiredMargin: 500, preferredWalletKey: "slot-4" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("insufficient_balance");
  });

  it("release frees the wallet AND the capacity slot AND the (symbol,dir) claim", () => {
    const a = new TickAllocator(baseInputs({ maxNewEntries: 1 }));
    const r = a.tryReserve({ symbol: "BTC-USDT", direction: "long", requiredMargin: 100 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Same (symbol,dir) blocked while reservation held.
    expect(a.tryReserve({ symbol: "BTC-USDT", direction: "long", requiredMargin: 100 }).ok).toBe(false);
    a.release(r.token);
    // After release, same reservation is possible again.
    const again = a.tryReserve({ symbol: "BTC-USDT", direction: "long", requiredMargin: 100 });
    expect(again.ok).toBe(true);
    expect(a.remainingNewEntries).toBe(0);
  });

  it("allows a role wallet occupied by BTC to open a separate ETH campaign", () => {
    const a = new TickAllocator(baseInputs({
      wallets: [
        { walletKey: "slot-1", balance: 1000, occupied: true },
        { walletKey: "slot-2", balance: 1000, occupied: false },
      ],
      openPositions: [{ symbol: "BTC-USDT", direction: "long", walletKey: "slot-1" }],
    }));
    const r = a.tryReserve({ symbol: "ETH-USDT", direction: "long", requiredMargin: 100, preferredWalletKey: "slot-1" });
    expect(r.ok).toBe(true);
  });
});
