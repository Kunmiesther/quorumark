import { describe, expect, it } from "vitest";
import { evaluateSetupTimeframes } from "../timeframePolicy";

describe("15m execution setup policy", () => {
  it("fails closed when either native setup feed is absent", () => {
    expect(
      evaluateSetupTimeframes({
        direction: "long",
        oneHourAvailable: true,
        fourHourAvailable: false,
        oneHourBos: "bullish_bos",
        fourHourBos: "none",
      }),
    ).toEqual({ allowed: false, reason: "missing native 4h setup feed" });
  });

  it("blocks a direction opposed by either setup timeframe", () => {
    expect(
      evaluateSetupTimeframes({
        direction: "long",
        oneHourAvailable: true,
        fourHourAvailable: true,
        oneHourBos: "bullish_bos",
        fourHourBos: "bearish_bos",
      }).allowed,
    ).toBe(false);
    expect(
      evaluateSetupTimeframes({
        direction: "short",
        oneHourAvailable: true,
        fourHourAvailable: true,
        oneHourBos: "bullish_bos",
        fourHourBos: "bearish_bos",
      }).allowed,
    ).toBe(false);
  });

  it("allows aligned or neutral setup states", () => {
    expect(
      evaluateSetupTimeframes({
        direction: "long",
        oneHourAvailable: true,
        fourHourAvailable: true,
        oneHourBos: "bullish_bos",
        fourHourBos: "none",
      }).allowed,
    ).toBe(true);
  });

  it("rejects stale setup data", () => {
    expect(
      evaluateSetupTimeframes({
        direction: "long",
        oneHourAvailable: true,
        fourHourAvailable: true,
        oneHourBos: "bullish_bos",
        fourHourBos: "none",
        executionTsMs: 12 * 60 * 60_000,
        oneHourTsMs: 9 * 60 * 60_000,
        fourHourTsMs: 8 * 60 * 60_000,
      }),
    ).toEqual({ allowed: false, reason: "1h setup feed is stale" });
  });
});
