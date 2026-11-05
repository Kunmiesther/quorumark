import { describe, it, expect, afterEach } from "vitest";
import { dynamicUniverseEnvSet, isDynamicUniverseEnabled } from "../flag";

const ORIG = process.env.DYNAMIC_UNIVERSE_ENABLED;

afterEach(() => {
  if (ORIG === undefined) delete process.env.DYNAMIC_UNIVERSE_ENABLED;
  else process.env.DYNAMIC_UNIVERSE_ENABLED = ORIG;
});

describe("DYNAMIC_UNIVERSE_ENABLED flag", () => {
  it("defaults to OFF when env unset", () => {
    delete process.env.DYNAMIC_UNIVERSE_ENABLED;
    expect(dynamicUniverseEnvSet()).toBe(false);
    expect(isDynamicUniverseEnabled({ executionMode: "paper" })).toBe(false);
  });

  it("accepts truthy env values", () => {
    for (const val of ["1", "true", "on", "TRUE"]) {
      process.env.DYNAMIC_UNIVERSE_ENABLED = val;
      expect(dynamicUniverseEnvSet()).toBe(true);
    }
  });

  it("refuses to activate for testnet even when env is on", () => {
    process.env.DYNAMIC_UNIVERSE_ENABLED = "1";
    expect(isDynamicUniverseEnabled({ executionMode: "testnet" })).toBe(false);
  });

  it("refuses to activate for mainnet even when env is on", () => {
    process.env.DYNAMIC_UNIVERSE_ENABLED = "1";
    expect(isDynamicUniverseEnabled({ executionMode: "mainnet" })).toBe(false);
  });

  // ROLLBACK GUARD: the dynamic-universe pipeline is currently disabled at
  // the source (see src/lib/universe/flag.ts — `isDynamicUniverseEnabled`
  // hard-returns false). This test asserts the rollback stays in force:
  // even in paper mode with env=1, the flag MUST NOT activate. If a future
  // change intends to re-enable the pipeline, that is a deliberate code
  // change and this test must be updated in the same commit that flips it
  // back on — do not let the flag silently reactivate. `dynamicUniverseEnvSet`
  // continues to reflect the raw env var for diagnostics.
  it("stays OFF in paper mode even with env set (rollback in force)", () => {
    process.env.DYNAMIC_UNIVERSE_ENABLED = "1";
    expect(dynamicUniverseEnvSet()).toBe(true);
    expect(isDynamicUniverseEnabled({ executionMode: "paper" })).toBe(false);
  });
});
