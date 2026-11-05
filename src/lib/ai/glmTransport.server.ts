// Server-only. Direct GLM uses Z.ai's general API, never its Coding Plan endpoint.
export type GlmTransport = {
  provider: "zai" | "together";
  apiKey: string | undefined;
  url: string;
  model: string;
};

export function resolveGlmTransport(env: Record<string, string | undefined>): GlmTransport {
  const direct = env.TURTLEBOT_GLM_PROVIDER === "zai" || Boolean(env.TURTLEBOT_ZAI_API_KEY);
  if (direct)
    return {
      provider: "zai",
      apiKey: env.TURTLEBOT_ZAI_API_KEY,
      url: "https://api.z.ai/api/paas/v4/chat/completions",
      // Separate model setting prevents Together's vendor-prefixed ID leaking to Z.ai.
      model: env.TURTLEBOT_ZAI_MODEL || "glm-5.3",
    };
  return {
    provider: "together",
    apiKey: env.TURTLEBOT_TOGETHER_API_KEY,
    url: "https://api.together.xyz/v1/chat/completions",
    model: env.TURTLEBOT_GLM_MODEL || "zai-org/GLM-5.3-Flash",
  };
}

export function glmGenerationOptions(transport: GlmTransport, outputTokens: number) {
  if (transport.provider !== "zai") return { max_tokens: outputTokens };
  // GLM-5.3 requires thinking. Its budget includes reasoning; a 350-token
  // chat budget can otherwise return no answer. Keep requests bounded.
  return /^glm-5\.[23]/i.test(transport.model)
    ? { max_tokens: Math.max(4096, outputTokens), reasoning_effort: "low" }
    : { max_tokens: outputTokens, thinking: { type: "disabled" } };
}

export function directGlmSelected(env: Record<string, string | undefined>): boolean {
  return resolveGlmTransport(env).provider === "zai";
}
