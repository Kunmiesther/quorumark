// @vitest-environment node
import { describe, expect, it } from "vitest";
import { inspectSynFuturesAccount } from "./account.server";

// Opt-in public, read-only Base verification. Never loads keys, signs, funds,
// approves, broadcasts, or creates a strategy. Owner IDs must be supplied by the runner.
describe.skipIf(process.env.RUN_SYNFUTURES_RPC_READ !== "1")("SynFutures Base account read", () => {
  it("verifies the selected owner's deterministic account without declaring a live route", async () => {
    const owner = process.env.SYNFUTURES_READ_OWNER;
    const walletId = process.env.SYNFUTURES_READ_WALLET_ID;
    if (!owner || !walletId)
      throw new Error("Public owner address and wallet ID required for this read-only test");
    const account = await inspectSynFuturesAccount(owner, walletId);
    expect(account.address.toLowerCase()).not.toBe(owner.toLowerCase());
    expect(BigInt(account.observed_block)).toBeGreaterThan(0n);
    expect(account.execution_ready).toBe(false);
    expect(["deploy_safe", "deploy_module", "deployed"]).toContain(account.deployment_stage);
    console.info("Base account verification (read-only):", JSON.stringify(account));
  }, 90_000);
});
