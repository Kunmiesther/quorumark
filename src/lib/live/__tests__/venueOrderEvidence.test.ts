import { describe, expect, it } from "vitest";
import { tpOrderEvidence } from "../venueOrderEvidence";

describe("take-profit venue evidence", () => {
  it("does not mistake a stored order ID for a resting venue order", () => {
    expect(tpOrderEvidence("TP_SET", "123", [])).toBe("unverified");
    expect(tpOrderEvidence("PARTIAL_TP_SET", "123", [{ orderId: "456" }])).toBe("unverified");
    expect(tpOrderEvidence("TP_SET", null, [{ id: "123" }])).toBe("unverified");
  });

  it("recognizes the matching order in a reconciled venue list", () => {
    expect(tpOrderEvidence("TP_SET", "123", [{ orderId: "123" }])).toBe("visible");
    expect(tpOrderEvidence("PARTIAL_TP_SET", "123", [{ id: 123 }])).toBe("visible");
  });

  it("does not apply to an unscheduled TP state", () => {
    expect(tpOrderEvidence("HOLD_WITHOUT_TP", null, [])).toBe("not_applicable");
  });
});
