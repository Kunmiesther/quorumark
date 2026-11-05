// SERVER-ONLY provider adapters for the shadow committee.
//
// Isolation guarantees enforced here:
//   • No exchange credential, signer secret, or broker URL is read or
//     forwarded. The only secrets touched are model-provider keys.
//   • No Onixus credential is reused: the DeepSeek leg reads a TurtleBot-
//     scoped key name and nothing else.
//   • No module in this file imports the signer client, the broker client,
//     supabaseAdmin, or any order/execution helper. Enforced by a test.
//   • Every failure path returns a recorded `unavailable` outcome. Nothing
//     is guessed, defaulted, or retried into a fabricated answer.

import { z } from "zod";
import { directGlmSelected, glmGenerationOptions, resolveGlmTransport } from "../glmTransport.server";
import {
  canonicalJson,
  parseCommitteeResponse,
  type CommitteeRole,
  type MarketSnapshot,
  type ProviderOutcome,
  type UnavailableReason,
} from "./schema";
import { PROMPT_VERSION, buildSystemPrompt, buildUserPrompt } from "./prompts";

export { PROMPT_VERSION };

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const GOOGLE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const TOGETHER_URL = "https://api.together.xyz/v1/chat/completions";
// OpenRouter is OpenAI-compatible and routes every seat through one key.
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// DeepSeek is OpenAI-compatible: same /chat/completions shape, same Bearer
// auth, same `choices[0].message.content` response. It is called DIRECTLY
// rather than through the gateway because it uses its own TurtleBot-scoped
// key, which is what keeps this seat independent of the other two.
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

export const DEFAULT_TIMEOUT_MS = 20_000;
/** A snapshot older than this must not be evaluated. */
export const MAX_SNAPSHOT_AGE_MS = 15 * 60_000;

export interface RoleSpec {
  role: CommitteeRole;
  provider: "openai" | "anthropic" | "deepseek" | "google" | "zai" | "qwen" | "openrouter";
  /** Resolved at call time from env; may be a fallback default. */
  model: string;
  title: string;
}

/**
 * Owner-configured model per seat. The risk seat runs DeepSeek unless
 * `TURTLEBOT_DEEPSEEK_MODEL` overrides it; the key name is TurtleBot-scoped
 * so no Onixus credential is reachable from here.
 *
 * `deepseek-chat`, not `deepseek-reasoner`: the committee contract requires a
 * JSON object back, and the reasoner model does not support
 * `response_format: json_object`. A reasoning model here would spend its
 * budget on thinking tokens and return prose the parser rejects — recorded as
 * `unparseable` on every single evaluation.
 */
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";

/**
 * OpenRouter model ids are `vendor/model` strings. These defaults are the
 * current lineup and are overridden per seat by env, so a swap is a config
 * change. Verify each id against openrouter.ai/models before relying on it.
 */
export const DEFAULT_OPENROUTER_LEAD_MODEL = "openai/gpt-5.6-sol";
export const DEFAULT_OPENROUTER_RISK_MODEL = "deepseek/deepseek-chat";
export const DEFAULT_OPENROUTER_STRUCTURE_MODEL = "qwen/qwen3.5-9b";

export function resolveRoleSpecs(env: Record<string, string | undefined>): RoleSpec[] {
  // OpenRouter profile: one owner key routes every seat, and each seat's model
  // is set by env so the lineup can change without a code edit. It takes
  // precedence over the Together and gateway profiles when its key is present.
  if (env.TURTLEBOT_OPENROUTER_API_KEY) {
    return [
      {
        role: "lead",
        provider: "openrouter",
        model: env.TURTLEBOT_OPENROUTER_LEAD_MODEL || DEFAULT_OPENROUTER_LEAD_MODEL,
        title: "Lead trade thesis",
      },
      {
        role: "risk",
        provider: "openrouter",
        model: env.TURTLEBOT_OPENROUTER_RISK_MODEL || DEFAULT_OPENROUTER_RISK_MODEL,
        title: "Adversarial risk officer",
      },
      {
        role: "structure",
        provider: "openrouter",
        model: env.TURTLEBOT_OPENROUTER_STRUCTURE_MODEL || DEFAULT_OPENROUTER_STRUCTURE_MODEL,
        title: "Market structure & liquidity",
      },
    ];
  }
  // The lean profile switches on automatically when the owner configures one
  // Together key. Nothing about providers or seats is exposed to end users.
  // Until that key exists, retain the proven gateway profile so production
  // never loses two seats during rollout.
  const lean = Boolean(env.TURTLEBOT_TOGETHER_API_KEY);
  const glm = resolveGlmTransport(env);
  const useGlm = lean || directGlmSelected(env);
  return [
    {
      role: "lead",
      provider: useGlm ? "zai" : "openai",
      model: useGlm ? glm.model : "openai/gpt-5.6-sol",
      title: "Lead trade thesis",
    },
    {
      role: "risk",
      provider: "deepseek",
      model: env.TURTLEBOT_DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL,
      title: "Adversarial risk officer",
    },
    {
      role: "structure",
      provider: lean ? "qwen" : "google",
      model: lean
        ? env.TURTLEBOT_QWEN_MODEL || "Qwen/Qwen3.5-9B"
        : env.TURTLEBOT_GEMINI_MODEL || "google/gemini-3.1-pro-preview",
      title: "Market structure & liquidity",
    },
  ];
}

/**
 * Gateway-routed seats must carry an allowlisted `vendor/model` id. A bare
 * name (e.g. `gemini-2.5-flash`) is rejected by the gateway with a 400, which
 * previously surfaced as a generic `http_error` on every single evaluation —
 * indistinguishable from a provider outage. Validate the shape locally so a
 * configuration typo is recorded as exactly that.
 */
export function gatewayModelIdIsValid(model: string | undefined | null): boolean {
  if (typeof model !== "string") return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model.trim());
}



/** SHA-256 of the canonical snapshot. Ties every record to exact evidence. */
export async function evidenceHash(snapshot: MarketSnapshot): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(snapshot));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function unavailable(
  spec: RoleSpec,
  latencyMs: number,
  reason: UnavailableReason,
  detail: string,
): ProviderOutcome {
  return {
    role: spec.role,
    provider: spec.provider,
    model: spec.model,
    available: false,
    latencyMs,
    reason,
    // Sanitize: never echo a provider body, header, or key material.
    detail: String(detail).replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]").slice(0, 200),
  };
}

async function withTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; timedOut: boolean; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const value = await fn(ctrl.signal);
    return { ok: true, value };
  } catch (err) {
    const timedOut = ctrl.signal.aborted;
    return { ok: false, timedOut, error: err instanceof Error ? err.message : "call failed" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract assistant text without trusting shape.
 *
 * One format now: every seat speaks the OpenAI wire shape. The gateway seats
 * always did, and DeepSeek is OpenAI-compatible — which is why replacing
 * Anthropic here removed a parser rather than adding one. Anthropic's
 * `content[]` block format was the only reason a second schema existed.
 */
const openAiBodySchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    prompt_cache_hit_tokens: z.number().int().nonnegative().optional(),
    prompt_tokens_details: z.object({
      cached_tokens: z.number().int().nonnegative().optional(),
    }).optional(),
  }).optional(),
});
const anthropicBodySchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).min(1),
});
const googleBodySchema = z.object({
  candidates: z.array(z.object({
    content: z.object({ parts: z.array(z.object({ text: z.string().optional() })).min(1) }),
  })).min(1),
});

function extractText(provider: RoleSpec["provider"], body: unknown, direct = false): string | null {
  if (provider === "anthropic") {
    const parsed = anthropicBodySchema.safeParse(body);
    return parsed.success
      ? parsed.data.content.map((part) => part.text ?? "").join("").trim() || null
      : null;
  }
  if (provider === "google" && direct) {
    const parsed = googleBodySchema.safeParse(body);
    return parsed.success
      ? parsed.data.candidates[0].content.parts.map((part) => part.text ?? "").join("").trim() || null
      : null;
  }
  const parsed = openAiBodySchema.safeParse(body);
  return parsed.success ? parsed.data.choices[0].message.content : null;
}

function extractUsage(body: unknown): ProviderOutcome["usage"] {
  const parsed = openAiBodySchema.safeParse(body);
  if (!parsed.success || !parsed.data.usage) return undefined;
  return {
    inputTokens: parsed.data.usage.prompt_tokens ?? 0,
    outputTokens: parsed.data.usage.completion_tokens ?? 0,
    cachedInputTokens:
      parsed.data.usage.prompt_cache_hit_tokens ??
      parsed.data.usage.prompt_tokens_details?.cached_tokens ??
      0,
  };
}

/**
 * Call one provider. Independent by construction: the caller passes only the
 * shared snapshot, never another model's answer.
 */
export async function callProvider(
  spec: RoleSpec,
  snapshot: MarketSnapshot,
  env: Record<string, string | undefined>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  directApiKey?: string,
): Promise<ProviderOutcome> {
  const started = Date.now();
  // Versioned system charter + sanitized snapshot as a separate user turn, so
  // snapshot content can never be read as an instruction.
  const system = buildSystemPrompt(spec.role);
  const user = buildUserPrompt(snapshot);

  let url: string;
  let headers: Record<string, string>;
  let payload: Record<string, unknown>;

  if (directApiKey && spec.provider === "openai") {
    url = OPENAI_URL;
    headers = { "content-type": "application/json", authorization: `Bearer ${directApiKey}` };
    payload = {
      model: spec.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_object" },
    };
  } else if (directApiKey && spec.provider === "anthropic") {
    url = ANTHROPIC_URL;
    headers = {
      "content-type": "application/json",
      "x-api-key": directApiKey,
      "anthropic-version": "2023-06-01",
    };
    payload = {
      model: spec.model,
      max_tokens: 1200,
      system,
      messages: [{ role: "user", content: user }],
    };
  } else if (directApiKey && spec.provider === "google") {
    url = `${GOOGLE_URL}/${encodeURIComponent(spec.model)}:generateContent`;
    headers = { "content-type": "application/json", "x-goog-api-key": directApiKey };
    payload = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { responseMimeType: "application/json" },
    };
  } else if (spec.provider === "anthropic") {
    return unavailable(spec, 0, "missing_credential", "Anthropic API key is not configured");
  } else if (spec.provider === "deepseek") {
    const key = env.TURTLEBOT_DEEPSEEK_API_KEY;
    if (!key) {
      return unavailable(
        spec,
        0,
        "missing_credential",
        // Names the provider, NOT the env var. `unavailable()` redacts any
        // 24+ char token and TURTLEBOT_DEEPSEEK_API_KEY is 26, so embedding
        // it yields "[redacted] is not configured" — an operator learns
        // nothing. The provider field carries the rest.
        "DeepSeek API key is not configured",
      );
    }
    // Deliberately NOT gatewayModelIdIsValid: that check exists because the
    // gateway requires a `vendor/model` id. This is a direct call and
    // DeepSeek takes a bare name (`deepseek-chat`), so applying it would
    // reject every valid model.
    url = DEEPSEEK_URL;
    headers = {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    };
    payload = {
      model: spec.model,
      max_tokens: 1200,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      // The committee contract is a JSON object. Enforced at the provider so
      // a prose answer is a provider-side error rather than something the
      // parser has to salvage.
      response_format: { type: "json_object" },
    };
  } else if (spec.provider === "openrouter") {
    if (!gatewayModelIdIsValid(spec.model)) {
      return unavailable(
        spec,
        0,
        "invalid_model_config",
        `model id "${spec.model}" is not a routable vendor/model identifier`,
      );
    }
    const key = env.TURTLEBOT_OPENROUTER_API_KEY;
    if (!key) {
      return unavailable(spec, 0, "missing_credential", "OpenRouter API key is not configured");
    }
    url = OPENROUTER_URL;
    headers = {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    };
    payload = {
      model: spec.model,
      max_tokens: 1200,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    };
  } else if (spec.provider === "zai" && directGlmSelected(env)) {
    const glm = resolveGlmTransport(env);
    if (!glm.apiKey) return unavailable(spec, 0, "missing_credential", "Z.ai API key is not configured");
    if (!/^glm-[a-z0-9.-]+$/i.test(spec.model))
      return unavailable(spec, 0, "invalid_model_config", "Z.ai requires a native GLM model identifier");
    url = glm.url;
    headers = { "content-type": "application/json", authorization: `Bearer ${glm.apiKey}` };
    payload = {
      model: spec.model,
      ...glmGenerationOptions({ ...glm, model: spec.model }, 1200),
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_object" },
    };
  } else if (spec.provider === "zai" || spec.provider === "qwen") {
    if (!gatewayModelIdIsValid(spec.model)) {
      return unavailable(
        spec,
        0,
        "invalid_model_config",
        `model id "${spec.model}" is not a routable vendor/model identifier`,
      );
    }
    const key = env.TURTLEBOT_TOGETHER_API_KEY;
    if (!key) {
      return unavailable(spec, 0, "missing_credential", "Together API key is not configured");
    }
    url = TOGETHER_URL;
    headers = {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    };
    payload = {
      model: spec.model,
      max_tokens: 1200,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    };
  } else {
    if (!gatewayModelIdIsValid(spec.model)) {
      return unavailable(
        spec,
        0,
        "invalid_model_config",
        `model id "${spec.model}" is not a routable vendor/model identifier`,
      );
    }
    const key = env.LOVABLE_API_KEY;

    if (!key) {
      return unavailable(
        spec,
        0,
        "missing_credential",
        "LOVABLE_API_KEY is not configured",
      );
    }
    url = GATEWAY_URL;
    headers = { "content-type": "application/json", "Lovable-API-Key": key };
    payload = {
      model: spec.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      ...(spec.model.startsWith("openai/gpt-5.6") ? { reasoning_effort: "none" } : {}),
    };
  }


  const res = await withTimeout(timeoutMs, async (signal) => {
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
    });
    if (!r.ok) {
      // Read the real provider reason (billing, bad model id, rate limit).
      // Without it every failure collapsed into "provider error" and the seat
      // looked dead with no way to tell why.
      let reason = "";
      try {
        const body = await r.text();
        const parsedBody = JSON.parse(body) as { error?: { message?: string } };
        reason = parsedBody?.error?.message ?? body;
      } catch {
        /* body unreadable — status alone */
      }
      throw new Error(
        `provider responded ${r.status}${reason ? `: ${reason.slice(0, 160)}` : ""}`,
      );
    }
    return (await r.json()) as unknown;
  });


  const latencyMs = Date.now() - started;

  if (!res.ok) {
    return unavailable(
      spec,
      latencyMs,
      res.timedOut ? "timeout" : "http_error",
      res.timedOut ? `no answer within ${timeoutMs}ms` : res.error,
    );
  }

  const text = extractText(spec.provider, res.value, Boolean(directApiKey));
  const parsed = parseCommitteeResponse(text);
  if (!parsed.ok) {
    return { ...unavailable(spec, latencyMs, parsed.reason, parsed.detail), usage: extractUsage(res.value) };
  }

  return {
    role: spec.role,
    provider: spec.provider,
    model: spec.model,
    available: true,
    latencyMs,
    usage: extractUsage(res.value),
    response: parsed.value,
  };
}

/**
 * Gateway model used to keep a seat alive when its primary provider is
 * unreachable (billing, outage, bad model id). The seat still answers with its
 * own charter/prompt — only the transport changes — and the recorded outcome
 * carries the fallback model id so the substitution is never hidden.
 */
export const FALLBACK_GATEWAY_MODEL = "google/gemini-3.6-flash";
export const LEAN_FALLBACK_MODEL = "Qwen/Qwen3.8-Flash";

/** Transport-level failures worth retrying on the gateway. */
const FALLBACK_REASONS: UnavailableReason[] = [
  "missing_credential",
  "http_error",
  "timeout",
  "invalid_model_config",
  "empty_response",
];

export interface FirstRoundOptions {
  specs?: RoleSpec[];
  credentials?: Partial<Record<RoleSpec["provider"], string>>;
  /** Custom Councils never substitute a provider the user did not choose. */
  allowGatewayFallback?: boolean;
  /** Receives every paid provider attempt, including a failed primary before fallback. */
  onAttempt?: (outcome: ProviderOutcome) => void;
}

/** Run the full first round. Independent, concurrent, fail-closed per leg. */
export async function runFirstRound(
  snapshot: MarketSnapshot,
  env: Record<string, string | undefined>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options: FirstRoundOptions = {},
): Promise<ProviderOutcome[]> {
  const specs = options.specs ?? resolveRoleSpecs(env);
  const allowGatewayFallback = options.allowGatewayFallback ?? options.specs == null;
  const now = Date.now();
  if (now - snapshot.candle_close_ms > MAX_SNAPSHOT_AGE_MS) {
    return specs.map((spec) =>
      unavailable(spec, 0, "stale_snapshot", "snapshot candle is too old to evaluate"),
    );
  }
  return Promise.all(
    specs.map(async (spec) => {
      const primary = await callProvider(
        spec,
        snapshot,
        env,
        timeoutMs,
        options.credentials?.[spec.provider],
      );
      options.onAttempt?.(primary);
      if (primary.available) return primary;
      // Direct GLM is an explicit billing boundary, not permission to spend
      // Together credits if Z.ai is unavailable or its key has not been added.
      if (spec.provider === "zai" && directGlmSelected(env)) return primary;
      if (!allowGatewayFallback) return primary;
      // An OpenRouter seat already is the gateway; a fallback would silently
      // swap the model, so the failure is recorded as-is.
      if (spec.provider === "openrouter") return primary;
      if (!FALLBACK_REASONS.includes(primary.reason)) return primary;

      const lean = Boolean(env.TURTLEBOT_TOGETHER_API_KEY);
      const fallbackSpec: RoleSpec = lean
        ? { ...spec, provider: "qwen", model: LEAN_FALLBACK_MODEL }
        : { ...spec, provider: "google", model: FALLBACK_GATEWAY_MODEL };
      if (spec.provider === fallbackSpec.provider && spec.model === fallbackSpec.model) return primary;
      if (lean ? !env.TURTLEBOT_TOGETHER_API_KEY : !env.LOVABLE_API_KEY) return primary;

      const fallback = await callProvider(fallbackSpec, snapshot, env, timeoutMs);
      options.onAttempt?.(fallback);
      if (!fallback.available) {
        // Report the ORIGINAL failure — the fallback is a rescue, not the
        // story. Keep both reasons visible in the detail line.
        return unavailable(
          spec,
          primary.latencyMs + fallback.latencyMs,
          primary.reason,
          `${primary.detail ?? primary.reason}; fallback ${fallbackSpec.model} also failed`,
        );
      }
      return fallback;
    }),
  );
}
