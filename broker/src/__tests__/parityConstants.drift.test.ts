/**
 * The broker vendors a hand-copied subset of
 * shared/mainnet_parity_constants.json because its Docker build context is
 * broker/ only. Hand-copied means it rots: the vendored `max_leverage` sat
 * at 10 while the owner-ratified value was 100, so every brokered live
 * directive would have been clamped to a tenth of the intended leverage
 * with nothing failing to say so.
 *
 * This test is the sync mechanism the comment in parityConstants.ts claims
 * exists. It compares the vendored subset field-by-field against the real
 * source of truth, so the drift becomes a red test instead of a silent
 * sizing bug.
 */
import { describe, it, expect } from "vitest";
import PARITY from "../parityConstants";
import SHARED from "../../../shared/mainnet_parity_constants.json";

describe("broker vendored parity constants match the shared source of truth", () => {
  it("mirrors every pilot sizing bound exactly", () => {
    const shared = SHARED.pilot as Record<string, unknown>;
    for (const key of Object.keys(PARITY.pilot) as (keyof typeof PARITY.pilot)[]) {
      expect(PARITY.pilot[key], `pilot.${key} drifted from shared JSON`).toBe(shared[key]);
    }
  });

  it("clamps at the owner-ratified 100x ceiling, not a stale lower one", () => {
    expect(PARITY.pilot.max_leverage).toBe(100);
  });

  it("mirrors the directive-type whitelist", () => {
    expect([...PARITY.enums.directive_types].sort())
      .toEqual([...(SHARED.enums.directive_types as string[])].sort());
  });
});
