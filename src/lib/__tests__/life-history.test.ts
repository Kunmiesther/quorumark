import { describe, it, expect } from "vitest";
import { mapObligationEvent } from "../life-history";

describe("mapObligationEvent", () => {
  it("INSERT => created", () => {
    expect(mapObligationEvent("INSERT", null, "upcoming")).toBe("created");
  });
  it("DELETE => deleted", () => {
    expect(mapObligationEvent("DELETE", "paid", null)).toBe("deleted");
  });
  it("UPDATE to 'paid' => paid", () => {
    expect(mapObligationEvent("UPDATE", "upcoming", "paid")).toBe("paid");
  });
  it("UPDATE to 'funded' => funded", () => {
    expect(mapObligationEvent("UPDATE", "upcoming", "funded")).toBe("funded");
  });
  it("UPDATE to 'overdue' => overdue", () => {
    expect(mapObligationEvent("UPDATE", "upcoming", "overdue")).toBe("overdue");
  });
  it("UPDATE with no status change => updated", () => {
    expect(mapObligationEvent("UPDATE", "upcoming", "upcoming")).toBe("updated");
  });
  it("UPDATE to a non-tracked status => updated", () => {
    expect(mapObligationEvent("UPDATE", "upcoming", "snoozed")).toBe("updated");
  });
  it("UPDATE where status was already 'paid' and stays 'paid' => updated", () => {
    expect(mapObligationEvent("UPDATE", "paid", "paid")).toBe("updated");
  });
});

describe.skip("life_obligation_history DB behavior (isolated DB required)", () => {
  it("authenticated cannot INSERT into life_obligation_history", () => {});
  it("authenticated cannot UPDATE or DELETE life_obligation_history", () => {});
  it("trigger writes 'paid' history when obligation status flips to paid", () => {});
  it("disconnected connection => confirmed_risk_capital returns 0", () => {});
  it("two 'unconfirmed' rows on same connection rejected", () => {});
  it("two 'revoked' rows on same connection allowed", () => {});
  it("new user receives exactly 8 life_categories; re-run creates no duplicates", () => {});
});
