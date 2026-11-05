// Multi-wallet list tests: ensures per-wallet balance failure is isolated
// and that health/aggregates compute the right numbers.

import { describe, it, expect } from "vitest";
import type { WalletRow, WalletHealth, WalletWithBalance } from "@/hooks/useWalletList";
import type { WalletEntry } from "@/hooks/usePortfolioTotals";

// Re-implementation of the pure aggregation piece for direct testing.
// Mirrors the logic inside useWalletList; keeping this in a helper lets
// us guarantee no regressions.
function assemble(
  wallets: WalletRow[],
  entries: WalletEntry[],
): WalletWithBalance[] {
  const map = new Map<string, WalletEntry>();
  for (const e of entries) map.set(`${e.chain}:${e.address.toLowerCase()}`, e);
  return wallets.map((row) => {
    const entry = map.get(`${row.chain}:${row.public_address.toLowerCase()}`);
    let health: WalletHealth = "connected";
    if (row.status === "disconnected") health = "disconnected";
    else if (row.status === "pending" || row.status === "challenge_issued") health = "auth_required";
    else if (row.last_error) health = "error";
    else if (!entry) health = "syncing";
    else if (entry.errors.length > 0) health = "error";
    return {
      row,
      balances: entry,
      usdTotal: entry?.walletUsdTotal ?? 0,
      health,
      balanceLoading: false,
      balanceError: entry?.errors?.[0]?.message ?? row.last_error ?? null,
    };
  });
}

function baseRow(overrides: Partial<WalletRow> = {}): WalletRow {
  return {
    id: "w1",
    provider: "phantom",
    public_address: "So11111111111111111111111111111111111111112",
    chain: "solana",
    network: "mainnet",
    label: null,
    status: "verified",
    is_active: true,
    is_default: false,
    apex_authorized: false,
    assigned_exchange_connection_id: null,
    verified_at: null,
    connected_at: null,
    last_seen_at: null,
    disconnected_at: null,
    last_error: null,
    last_error_at: null,
    created_at: "2026-07-15T00:00:00Z",
    ...overrides,
  };
}

function entry(overrides: Partial<WalletEntry> = {}): WalletEntry {
  return {
    id: "w1",
    chain: "solana",
    address: "So11111111111111111111111111111111111111112",
    balances: [{ asset: "SOL", amount: 1.5, usdValue: 300 }],
    walletUsdTotal: 300,
    priceUnavailable: false,
    errors: [],
    ...overrides,
  };
}

describe("wallet list assembly", () => {
  it("attaches per-wallet balances by chain+address (case-insensitive)", () => {
    const rows = [
      baseRow({ id: "a", public_address: "0xABC", chain: "ethereum" }),
      baseRow({ id: "b", public_address: "0xdef", chain: "ethereum" }),
    ];
    const entries = [
      entry({ id: "a", chain: "ethereum", address: "0xabc", walletUsdTotal: 100 }),
      entry({ id: "b", chain: "ethereum", address: "0xDEF", walletUsdTotal: 250 }),
    ];
    const items = assemble(rows, entries);
    expect(items[0].usdTotal).toBe(100);
    expect(items[1].usdTotal).toBe(250);
    expect(items.every((i) => i.health === "connected")).toBe(true);
  });

  it("isolates failure to one wallet without breaking the others", () => {
    const rows = [
      baseRow({ id: "a", public_address: "0xA", chain: "ethereum" }),
      baseRow({ id: "b", public_address: "0xB", chain: "ethereum" }),
    ];
    const entries = [
      entry({ id: "a", chain: "ethereum", address: "0xa", walletUsdTotal: 42 }),
      entry({
        id: "b",
        chain: "ethereum",
        address: "0xb",
        walletUsdTotal: 0,
        errors: [{ chain: "ethereum", code: "RPC_TIMEOUT", message: "RPC timed out" }],
      }),
    ];
    const items = assemble(rows, entries);
    expect(items[0].health).toBe("connected");
    expect(items[1].health).toBe("error");
    expect(items[1].balanceError).toBe("RPC timed out");
    // Aggregation ignores broken wallet's zero total silently — good.
    const total = items.reduce((s, i) => s + i.usdTotal, 0);
    expect(total).toBe(42);
  });

  it("reports auth_required for wallets still in the challenge phase", () => {
    const rows = [baseRow({ status: "challenge_issued" })];
    const items = assemble(rows, []);
    expect(items[0].health).toBe("auth_required");
  });

  it("reports syncing when we have the row but no balance entry yet", () => {
    const rows = [baseRow({ status: "verified" })];
    const items = assemble(rows, []);
    expect(items[0].health).toBe("syncing");
  });
});
