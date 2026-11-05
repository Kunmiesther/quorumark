/** Tests for the strict internal-company Scout scan scope. */
import { describe, expect, it } from "vitest";
import { DEFAULT_PAPER_SYMBOLS } from "@/lib/paper/constants";
import { computeRotationBatch, MAX_SCAN_SYMBOLS, selectScanUniverse } from "../scanScope";

const unusedSupabase = {} as Parameters<typeof selectScanUniverse>[0]["supabase"];

describe("computeRotationBatch", () => {
  it("returns the whole allowlist without rotating when it fits", () => {
    const out = computeRotationBatch([...DEFAULT_PAPER_SYMBOLS], 3, MAX_SCAN_SYMBOLS);
    expect(out.symbols).toEqual(DEFAULT_PAPER_SYMBOLS);
    expect(out.nextCursor).toBe(0);
  });

  it("keeps a bounded batch deterministic", () => {
    const out = computeRotationBatch([...DEFAULT_PAPER_SYMBOLS], 1, 2);
    expect(out.symbols).toEqual(DEFAULT_PAPER_SYMBOLS.slice(1, 3));
    expect(out.nextCursor).toBe(3);
  });
});

describe("selectScanUniverse", () => {
  it("selects exactly BTC, XRP, SOL, and ETH for internal testing", async () => {
    const out = await selectScanUniverse({ supabase: unusedSupabase, userId: "u1" });

    expect(out.source).toBe("internal_testing_allowlist");
    expect(out.symbols).toEqual(["BTC-USDT", "XRP-USDT", "SOL-USDT", "ETH-USDT"]);
    expect(out.coverage).toEqual(out.symbols);
    expect(out.discoveredCount).toBe(4);
    expect(out.eligibleCount).toBe(4);
    expect(out.coverageCount).toBe(4);
    expect(out.scannedThisCycle).toBe(4);
    expect(out.snapshotId).toBeNull();
  });

  it("cannot be widened by dynamic or legacy database rows", async () => {
    const throwingSupabase = new Proxy(
      {},
      {
        get: () => {
          throw new Error("scan scope must not query a dynamic universe");
        },
      },
    ) as Parameters<typeof selectScanUniverse>[0]["supabase"];

    const out = await selectScanUniverse({ supabase: throwingSupabase, userId: "u1" });
    expect(out.symbols).toEqual(DEFAULT_PAPER_SYMBOLS);
  });
});
