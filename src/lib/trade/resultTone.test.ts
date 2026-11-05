import { expect, it } from "vitest";
import { resultTone } from "./resultTone";
it("does not present missing, non-finite or flat P&L as a gain", () => {
  for (const value of [null, NaN, Infinity, -Infinity, 0, -0])
    expect(resultTone(value)).toBe("neutral");
  expect(resultTone(12)).toBe("positive");
  expect(resultTone(-12)).toBe("negative");
});
