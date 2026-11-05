import { describe, expect, it } from "vitest";
import { resolveGlmTransport, glmGenerationOptions } from "../glmTransport.server";

describe("direct GLM transport", () => {
  it("prefers the direct key, never a Together model ID or coding endpoint", () => {
    const transport = resolveGlmTransport({ TURTLEBOT_ZAI_API_KEY: "direct",
      TURTLEBOT_TOGETHER_API_KEY: "legacy", TURTLEBOT_GLM_MODEL: "zai-org/GLM-5.3-Flash" });
    expect(transport).toEqual({ provider: "zai", apiKey: "direct",
      url: "https://api.z.ai/api/paas/v4/chat/completions", model: "glm-5.3" });
    expect(glmGenerationOptions(transport, 350)).toEqual({ max_tokens: 4096, reasoning_effort: "low" });
  });
  it("fails without a key when direct routing is explicitly selected", () => {
    expect(resolveGlmTransport({ TURTLEBOT_GLM_PROVIDER: "zai", TURTLEBOT_TOGETHER_API_KEY: "legacy" }))
      .toMatchObject({ provider: "zai", apiKey: undefined });
  });
  it("preserves rollout compatibility until the direct key is installed", () => {
    expect(resolveGlmTransport({ TURTLEBOT_TOGETHER_API_KEY: "legacy" }).provider).toBe("together");
  });
  it("supports separately configured direct models and their request dialect", () => {
    const transport = resolveGlmTransport({ TURTLEBOT_ZAI_API_KEY: "direct", TURTLEBOT_ZAI_MODEL: "glm-4.7-flash" });
    expect(glmGenerationOptions(transport, 1200)).toEqual({ max_tokens: 1200, thinking: { type: "disabled" } });
  });
});
