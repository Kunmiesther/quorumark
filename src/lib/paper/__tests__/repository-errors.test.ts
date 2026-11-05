import { describe, expect, it } from "vitest";
import { sanitizeRpcError } from "../repository";

describe("sanitizeRpcError", () => {
  it("preserves the SQLSTATE and application guard token", () => {
    expect(sanitizeRpcError({
      code: "23514",
      message: "paper_orchestration_missing: no linked AI orchestration trace for ADA-USDT/long",
    })).toBe("23514/paper_orchestration_missing");
  });

  it("removes free-form detail and unsafe characters", () => {
    expect(sanitizeRpcError({
      code: "42501",
      message: "paper authority violation! user=secret: internal detail",
    })).toBe("42501/paper_authority_violation__user_secret");
  });

  it("uses bounded fallbacks for malformed errors", () => {
    expect(sanitizeRpcError(null)).toBe("unknown/unspecified");
  });
});