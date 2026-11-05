import { describe, expect, it } from "vitest";
import { validLiveLeverage } from "./liveLeverage";

describe("explicit live leverage", () => {
  it("keeps venue ceilings separate", () => {
    expect(validLiveLeverage(125, "aster")).toBe(true);
    expect(validLiveLeverage(125, "apex_omni")).toBe(false);
    expect(validLiveLeverage(100, "apex_omni")).toBe(true);
    expect(validLiveLeverage(1, "synfutures")).toBe(false);
  });
  it.each([0, -1, 125.5, 126, NaN, Infinity])("rejects invalid Aster input %s", (value) => {
    expect(validLiveLeverage(value, "aster")).toBe(false);
  });
});
