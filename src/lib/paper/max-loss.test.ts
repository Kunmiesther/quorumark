import { describe, it, expect } from "vitest";
import { shouldTriggerMaxLoss, MAX_LOSS_MARGIN_FRAC } from "./engine";

describe("shouldTriggerMaxLoss", () => {
  it("triggers when worst-case unrealized loss reaches the cap", () => {
    expect(shouldTriggerMaxLoss(10, -5)).toBe(true);   // exactly 50%
    expect(shouldTriggerMaxLoss(10, -8)).toBe(true);   // 80%
  });
  it("does not trigger below the cap or on gains", () => {
    expect(shouldTriggerMaxLoss(10, -4.9)).toBe(false);
    expect(shouldTriggerMaxLoss(10, 3)).toBe(false);
    expect(shouldTriggerMaxLoss(10, 0)).toBe(false);
  });
  it("is safe for zero/negative margin", () => {
    expect(shouldTriggerMaxLoss(0, -100)).toBe(false);
    expect(shouldTriggerMaxLoss(-5, -100)).toBe(false);
  });
  it("MAX_LOSS_MARGIN_FRAC is 50%", () => {
    expect(MAX_LOSS_MARGIN_FRAC).toBe(0.5);
  });
});
