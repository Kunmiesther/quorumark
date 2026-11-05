// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodeFunctionData, parseAbi } from "viem";
import {
  buildSynFuturesOwnerSetup,
  buildSynFuturesSessionRevocation,
  synFuturesModuleAbi,
  type SynFuturesSessionDraft,
} from "./smartAccount";

const now = 2_000_000_000;
const draft: SynFuturesSessionDraft = {
  chainId: 8453,
  safe: "0x0000000000000000000000000000000000000001",
  module: "0x0000000000000000000000000000000000000002",
  moduleEnabled: false,
  operator: "0x0000000000000000000000000000000000000003",
  validUntil: now + 3600,
  marginBudgetUsdc: "100",
  maxSlippageBps: 50,
  markets: [
    {
      symbol: "BTC-USDC",
      maxBaseSize: "0.01",
      maxNotionalUsdc: "1000",
      maxMarginPerTradeUsdc: "25",
      maxLeverage: 5,
    },
  ],
};
describe("SynFutures owner-controlled Safe setup", () => {
  it("renews an enabled module without sending enableModule again", () => {
    const plan = buildSynFuturesOwnerSetup({ ...draft, moduleEnabled: true }, now);
    expect(plan.calls).toHaveLength(4);
    expect(plan.calls.every((call) => call.to === draft.module)).toBe(true);
    expect(
      plan.calls.map(
        (call) => decodeFunctionData({ abi: synFuturesModuleAbi, data: call.data }).functionName,
      ),
    ).toEqual(["revokeSession", "configureMarket", "configureMarket", "configureSession"]);
  });
  it("refuses an unknown module enablement state", () => {
    expect(() =>
      buildSynFuturesOwnerSetup({ ...draft, moduleEnabled: undefined as never }, now),
    ).toThrow("MODULE_STATE_REQUIRED");
  });
  it("builds only unsigned, zero-value CALLs with session permission last", () => {
    const plan = buildSynFuturesOwnerSetup(draft, now);
    expect(plan).toMatchObject({
      executionReady: false,
      requiresOwnerSignature: true,
      requiresDeploymentVerification: true,
    });
    expect(plan.calls).toHaveLength(5);
    expect(plan.calls.every((call) => call.operation === 0 && call.value === "0")).toBe(true);
    expect(
      decodeFunctionData({ abi: synFuturesModuleAbi, data: plan.calls[0].data }).functionName,
    ).toBe("revokeSession");
    expect(plan.calls[1].to).toBe(draft.safe);
    expect(
      decodeFunctionData({
        abi: parseAbi(["function enableModule(address module)"]),
        data: plan.calls[1].data,
      }).args,
    ).toEqual([draft.module]);
    const config = decodeFunctionData({ abi: synFuturesModuleAbi, data: plan.calls[2].data });
    expect(config.functionName).toBe("configureMarket");
    expect(config.args?.[1]).toMatchObject({ maxMarginPerTrade: 25n * 10n ** 18n });
    expect(
      decodeFunctionData({ abi: synFuturesModuleAbi, data: plan.calls[3].data }).args?.[1],
    ).toMatchObject({ maxPositionSize: 0n });
    const session = decodeFunctionData({ abi: synFuturesModuleAbi, data: plan.calls[4].data });
    expect(session).toMatchObject({
      functionName: "configureSession",
      args: [draft.operator, now + 3600, 100n * 10n ** 18n, 50],
    });
  });
  it("supports both discovered USDC markets without inventing SOL/XRP", () => {
    expect(
      buildSynFuturesOwnerSetup(
        { ...draft, markets: [...draft.markets, { ...draft.markets[0], symbol: "ETH-USDC" }] },
        now,
      ).calls,
    ).toHaveLength(5);
    expect(() =>
      buildSynFuturesOwnerSetup(
        { ...draft, markets: [{ ...draft.markets[0], symbol: "SOL-USDC" as never }] },
        now,
      ),
    ).toThrow("UNSUPPORTED_MARKET");
  });
  it.each(["-1", "0", "1e2", "1.0000000000000000001", "NaN"])(
    "rejects malformed budget %s",
    (marginBudgetUsdc) => {
      expect(() => buildSynFuturesOwnerSetup({ ...draft, marginBudgetUsdc }, now)).toThrow(
        "INVALID_AMOUNT",
      );
    },
  );
  it("rejects wrong chain, expired session, identical roles and duplicate markets", () => {
    expect(() => buildSynFuturesOwnerSetup({ ...draft, chainId: 1 }, now)).toThrow("BASE_REQUIRED");
    expect(() => buildSynFuturesOwnerSetup({ ...draft, validUntil: now }, now)).toThrow(
      "INVALID_LIMIT",
    );
    expect(() => buildSynFuturesOwnerSetup({ ...draft, operator: draft.safe }, now)).toThrow(
      "DISTINCT_ROLES_REQUIRED",
    );
    expect(() =>
      buildSynFuturesOwnerSetup({ ...draft, markets: [...draft.markets, ...draft.markets] }, now),
    ).toThrow("DUPLICATE_MARKET");
  });
  it("does not replace invalid user limits with defaults", () => {
    expect(() => buildSynFuturesOwnerSetup({ ...draft, maxSlippageBps: 0 }, now)).toThrow(
      "INVALID_LIMIT",
    );
    expect(() => buildSynFuturesOwnerSetup({ ...draft, marginBudgetUsdc: "10" }, now)).toThrow(
      "MARGIN_EXCEEDS_SESSION_BUDGET",
    );
  });
  it("builds revocation separately without closing positions", () => {
    const call = buildSynFuturesSessionRevocation(draft.module);
    expect(decodeFunctionData({ abi: synFuturesModuleAbi, data: call.data }).functionName).toBe(
      "revokeSession",
    );
    expect(call.to).toBe(draft.module);
  });
});
