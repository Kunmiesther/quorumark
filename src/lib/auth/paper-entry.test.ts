import { beforeEach, describe, expect, it } from "vitest";
import { consumePaperEntry, hasPaperEntry, rememberPaperEntry } from "./paper-entry";

beforeEach(() => sessionStorage.clear());
describe("Google paper entry intent", () => {
  it("preserves intent through onboarding, consumes once, and defaults to normal navigation", () => {
    expect(consumePaperEntry()).toBe(false);
    expect(rememberPaperEntry(true, sessionStorage, 1000)).toBe(true);
    expect(hasPaperEntry(sessionStorage, 2000)).toBe(true);
    expect(hasPaperEntry(sessionStorage, 3000)).toBe(true);
    expect(consumePaperEntry(sessionStorage, 4000)).toBe(true);
    expect(consumePaperEntry(sessionStorage, 4000)).toBe(false);
  });
  it("expires stale intent and clears it for a normal sign-in", () => {
    rememberPaperEntry(true, sessionStorage, 1000);
    expect(hasPaperEntry(sessionStorage, 3_601_000)).toBe(false);
    expect(hasPaperEntry(sessionStorage, 999)).toBe(false);
    rememberPaperEntry(false);
    expect(hasPaperEntry(sessionStorage, 2000)).toBe(false);
  });
  it("does not accept redirect URLs or fail when browser storage is blocked", () => {
    sessionStorage.setItem("tb_paper_entry_v1", "https://example.com");
    expect(hasPaperEntry()).toBe(false);
    const blocked = {
      getItem() {
        throw Error("blocked");
      },
      setItem() {
        throw Error("blocked");
      },
      removeItem() {
        throw Error("blocked");
      },
    } as unknown as Storage;
    expect(rememberPaperEntry(true, blocked)).toBe(false);
    expect(consumePaperEntry(blocked)).toBe(false);
  });
});
