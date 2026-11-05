import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Regression guard for a defect found in production on 2026-07-31: the Onyx
 * panel carried its OWN hand-rolled six-stage "Pipeline" list alongside the
 * canonical flow, and it was wrong in three ways at once.
 *
 *   1. Stage 6 "Order intent" counted rows in `paper_order_intents` — the
 *      PAPER engine's table. A LIVE order intent was therefore never checked,
 *      and the stage read "IDLE · No order intents recorded for this account"
 *      no matter what the live pipeline had done.
 *   2. Stages 4 and 5 ("Risk checks", "Safety check") were hardcoded to
 *      "waiting" unless a kill switch was active. They evaluated nothing, yet
 *      asserted "No confirmed signals to size yet" as if they had.
 *   3. It was account-wide, so "no order intents" conflated "this candle
 *      produced none" with "you have never traded".
 *
 * The fix was deletion, not repair. Two pipeline views over one pipeline is
 * how they drift apart.
 */
const SRC = readFileSync("src/components/onyx/OnyxPanel.tsx", "utf8");

/** Executable source only — the comment explaining the removal is not a use. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("Onyx renders exactly one pipeline", () => {
  it("does not read the paper engine's intent table", () => {
    expect(CODE).not.toContain("paper_order_intents");
  });

  it("has no second, hand-rolled stage list", () => {
    expect(CODE).not.toMatch(/const stages\s*:/);
    expect(CODE).not.toMatch(/StageState/);
    expect(CODE).not.toContain("Market data feed");
    expect(CODE).not.toContain("Candle validation");
    expect(CODE).not.toContain("Signal detection");
  });

  it("delegates the flow to the single canonical component", () => {
    expect(CODE).toContain("LiveDecisionFlowPanel");
    expect(CODE.match(/<LiveDecisionFlowPanel\s*\/>/g) ?? []).toHaveLength(1);
  });

  it("carries none of the banned wording", () => {
    const lowered = CODE.toLowerCase();
    for (const banned of [
      "no order intents recorded",
      "order intent inactive",
      "safety check idle",
      "no confirmed signals to size yet",
      "ai approved",
    ]) {
      expect(lowered).not.toContain(banned);
    }
  });

  it("queries no table directly — the flow's server function owns the reads", () => {
    expect(CODE).not.toMatch(/supabase\s*\.\s*from\(/);
  });
});
