import { describe, it, expect } from "vitest";
import {
  pilotAllocation,
  pilotLeverage,
  PILOT_RESERVE_FLOOR_USD,
  PILOT_CEILING_USD,
  PILOT_MAX_LEVERAGE,
} from "../pilotSizing";

describe("paper: pilotSizing", () => {
  it("mirrors the shared JSON pilot constants", () => {
    expect(PILOT_RESERVE_FLOOR_USD).toBeGreaterThan(0);
    expect(PILOT_CEILING_USD).toBeGreaterThanOrEqual(PILOT_RESERVE_FLOOR_USD);
    expect(PILOT_MAX_LEVERAGE).toBeGreaterThanOrEqual(1);
  });
  it("allocates zero at or below the reserve floor", () => {
    expect(pilotAllocation(0)).toBe(0);
    expect(pilotAllocation(PILOT_RESERVE_FLOOR_USD)).toBe(0);
    expect(pilotAllocation(PILOT_RESERVE_FLOOR_USD + 1)).toBe(1);
  });
  it("caps at the ceiling", () => {
    expect(
      pilotAllocation(PILOT_RESERVE_FLOOR_USD + PILOT_CEILING_USD + 1_000_000),
    ).toBe(PILOT_CEILING_USD);
  });
  it("clamps leverage", () => {
    expect(pilotLeverage(1)).toBe(1);
    expect(pilotLeverage(PILOT_MAX_LEVERAGE + 999)).toBe(PILOT_MAX_LEVERAGE);
    expect(pilotLeverage(-999)).toBe(1);
  });
});
