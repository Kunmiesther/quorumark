import { describe, expect, it } from "vitest";
import { estimateAiUsageCost } from "@/lib/ai/usage.server";

describe("AI usage cost estimates", () => {
  it("uses the versioned GLM token rates", () => {
    const result = estimateAiUsageCost({
      model: "zai-org/GLM-5.3-Flash",
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0 },
    });
    expect(result.cost).toBeCloseTo(0.65, 8);
    expect(result.source).toBe("together:2026-09-09");
  });

  it("prices cached input separately", () => {
    const result = estimateAiUsageCost({
      model: "deepseek-chat",
      usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 },
    });
    expect(result.cost).toBeCloseTo(0.0028, 8);
  });

  it("flags unknown models rather than inventing a cost", () => {
    const result = estimateAiUsageCost({
      model: "future/model",
      usage: { inputTokens: 10_000, outputTokens: 1_000, cachedInputTokens: 0 },
    });
    expect(result.cost).toBe(0);
    expect(result.source).toBe("unpriced");
  });
});
