import { describe, expect, it } from "vitest";
import {
  assertLegacyExecutionDisabled,
  isQuorumarkMvpMode,
  quorumarkMvpDisabledResponse,
  QUORUMARK_MVP_DISABLED_CODE,
} from "../quorumark-mvp-policy.server";
import {
  isQuorumarkMvpMode as isEdgeQuorumarkMvpMode,
  quorumarkMvpDisabledResponse as edgeDisabledResponse,
} from "../../../supabase/functions/_shared/quorumark-mvp-guard";

describe("Quorumark MVP server boundary", () => {
  it("fails closed when configuration is missing or malformed", () => {
    expect(isQuorumarkMvpMode({})).toBe(true);
    expect(isQuorumarkMvpMode({ QUORUMARK_MVP_MODE: "true" })).toBe(true);
    expect(isQuorumarkMvpMode({ QUORUMARK_MVP_MODE: "0" })).toBe(true);
  });

  it("requires the exact server-side opt-out before legacy execution can proceed", () => {
    expect(isQuorumarkMvpMode({ QUORUMARK_MVP_MODE: "disabled" })).toBe(false);
    expect(() => assertLegacyExecutionDisabled("test", {})).toThrow(
      `${QUORUMARK_MVP_DISABLED_CODE}:test`,
    );
    expect(() =>
      assertLegacyExecutionDisabled("test", { QUORUMARK_MVP_MODE: "disabled" }),
    ).not.toThrow();
  });

  it("returns a consistent non-cacheable disabled response", async () => {
    const response = quorumarkMvpDisabledResponse("test");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      ok: false,
      error: QUORUMARK_MVP_DISABLED_CODE,
      operation: "test",
    });
  });

  it("does not accept a client-style flag as an override", () => {
    expect(
      isQuorumarkMvpMode({ QUORUMARK_MVP_MODE: "false", VITE_QUORUMARK_MVP_MODE: "disabled" }),
    ).toBe(true);
  });

  it("uses the same fail-closed rule in separately deployed Edge Functions", async () => {
    expect(isEdgeQuorumarkMvpMode(undefined)).toBe(true);
    expect(isEdgeQuorumarkMvpMode("malformed")).toBe(true);
    expect(isEdgeQuorumarkMvpMode("disabled")).toBe(false);
    const response = edgeDisabledResponse("edge-test");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: QUORUMARK_MVP_DISABLED_CODE });
  });
});
