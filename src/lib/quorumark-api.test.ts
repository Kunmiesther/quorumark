import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WALLET_SESSION_KEY,
  getStoredWalletSession,
  getWalletSession,
  quorumarkApi,
  saveWalletSession,
} from "@/lib/quorumark-api";

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("application wallet sessions", () => {
  it("keeps the connected identity visible while rejecting an expired application session", () => {
    saveWalletSession({ address: "estarkunmi.testnet", chain: "near:testnet", verified: true, token: "expired", expiresAt: new Date(Date.now() - 1_000).toISOString() });
    expect(getWalletSession()).toBeNull();
    expect(getStoredWalletSession()?.address).toBe("estarkunmi.testnet");
  });

  it("clears application credentials and gives a recovery instruction after a 401", async () => {
    saveWalletSession({ address: "estarkunmi.testnet", chain: "near:testnet", verified: true, token: "invalid", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "Expired application session" }), { status: 401 })));
    await expect(quorumarkApi("/v1/strategies/mine")).rejects.toThrow("Verify your wallet again");
    expect(JSON.parse(sessionStorage.getItem(WALLET_SESSION_KEY) ?? "{}").verified).toBe(false);
  });
});
