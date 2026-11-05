import { describe, it, expect } from "vitest";
import {
  parseRejectReason,
  ALLOWED_CATEGORIES,
  UNCLASSIFIED,
} from "../../../../supabase/functions/_shared/venue-reject";

describe("parseRejectReason", () => {
  it("decodes code 3 with its category", () => {
    const f = parseRejectReason(
      "ENTRY_SUBMIT_FAILED:UPSTREAM_REJECT:3:VENUE_REJECT_INSUFFICIENT_MARGIN",
      "Insufficient available margin at venue",
    );
    expect(f.signer_mapping).toBe("ENTRY_SUBMIT_FAILED");
    expect(f.venue_code).toBe("3");
    expect(f.venue_category).toBe("VENUE_REJECT_INSUFFICIENT_MARGIN");
    expect(f.venue_message).toBe("Insufficient available margin at venue");
  });

  it("never collapses the category away when present", () => {
    const f = parseRejectReason("UPSTREAM_REJECT:3:VENUE_REJECT_PRICE_BOUNDS");
    expect(f.venue_category).toBe("VENUE_REJECT_PRICE_BOUNDS");
  });

  it("rejects categories outside the allowlist", () => {
    const f = parseRejectReason("X:UPSTREAM_REJECT:3:TOTALLY_MADE_UP");
    expect(f.venue_category).toBe(UNCLASSIFIED);
    expect(f.venue_message).toBeNull();
  });

  it("drops any message when unclassified", () => {
    const f = parseRejectReason("X:UPSTREAM_REJECT:3", "some raw venue prose");
    expect(f.venue_message).toBeNull();
  });

  it("strips secret/header-looking material and bounds length", () => {
    const f = parseRejectReason(
      "ENTRY_SUBMIT_FAILED:UPSTREAM_REJECT:3:VENUE_REJECT_AUTH",
      "Authorization: Bearer abc.def.ghi " + "x".repeat(5000),
    );
    expect(f.venue_message).not.toBeNull();
    expect(f.venue_message!.length).toBeLessThanOrEqual(120);
    expect(f.venue_message).not.toContain(":");
  });

  it("bounds an oversized venue code", () => {
    const f = parseRejectReason("A:UPSTREAM_REJECT:" + "9".repeat(500) + ":" + UNCLASSIFIED);
    expect(f.venue_code!.length).toBeLessThanOrEqual(32);
  });

  it("treats timeouts as ambiguity, not a venue reject", () => {
    const f = parseRejectReason("SIGNER_TIMEOUT");
    expect(f.signer_mapping).toBe("SIGNER_TIMEOUT");
    expect(f.venue_code).toBeNull();
    expect(f.venue_category).toBeNull();
  });

  it("is safe on null/empty input", () => {
    for (const v of [null, undefined, ""]) {
      const f = parseRejectReason(v as string | null);
      expect(f.venue_category).toBeNull();
      expect(f.venue_message).toBeNull();
    }
  });

  it("is deterministic for duplicate responses", () => {
    const a = parseRejectReason("E:UPSTREAM_REJECT:3:VENUE_REJECT_DUPLICATE", "Duplicate client order id at venue");
    const b = parseRejectReason("E:UPSTREAM_REJECT:3:VENUE_REJECT_DUPLICATE", "Duplicate client order id at venue");
    expect(a).toEqual(b);
  });

  it("only ever emits allowlisted categories", () => {
    for (const cat of ["VENUE_REJECT_LEVERAGE", "NOPE", "", "VENUE_REJECT_AUTH"]) {
      const f = parseRejectReason(`E:UPSTREAM_REJECT:3:${cat}`);
      expect(ALLOWED_CATEGORIES.has(f.venue_category!)).toBe(true);
    }
  });
});
