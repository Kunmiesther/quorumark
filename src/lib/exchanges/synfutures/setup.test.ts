import { describe, expect, it } from "vitest";
import { synFuturesSetupInput } from "./setup";

const valid = {
  walletId: "00000000-0000-4000-8000-000000000001",
  allocationUsdc: "100",
  maxLeverage: 33,
  expectedRevision: 0,
};
describe("SynFutures configuration input", () => {
  it("accepts the requested allocation and ceiling without activation fields", () => {
    expect(synFuturesSetupInput.parse(valid)).toEqual(valid);
  });
  it.each([
    "0",
    "-100",
    "NaN",
    "Infinity",
    "1e2",
    "0.0000001",
    "100000000000000",
    "99999999999999.123456",
  ])("rejects invalid or imprecise USDC %s", (allocationUsdc) => {
    expect(synFuturesSetupInput.safeParse({ ...valid, allocationUsdc }).success).toBe(false);
  });
  it.each([0, -1, 33.5, Infinity, 65536])("rejects invalid leverage %s", (maxLeverage) => {
    expect(synFuturesSetupInput.safeParse({ ...valid, maxLeverage }).success).toBe(false);
  });
  it("does not accept an injected owner or live status", () => {
    expect(synFuturesSetupInput.safeParse({ ...valid, userId: "other" }).success).toBe(false);
    expect(synFuturesSetupInput.safeParse({ ...valid, status: "live" }).success).toBe(false);
    expect(synFuturesSetupInput.safeParse({ ...valid, expectedRevision: -1 }).success).toBe(false);
  });
});
