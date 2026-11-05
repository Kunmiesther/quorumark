import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { aggregateCommittee, MIN_AVAILABLE_PROVIDERS } from "@/lib/ai/committee/aggregate";
import {
  COMMITTEE_SCHEMA_VERSION,
  canonicalJson,
  parseCommitteeResponse,
  type MarketSnapshot,
  type ProviderOutcome,
} from "@/lib/ai/committee/schema";
import {
  callProvider,
  evidenceHash,
  resolveRoleSpecs,
  runFirstRound,
  MAX_SNAPSHOT_AGE_MS,
  FALLBACK_GATEWAY_MODEL,
} from "@/lib/ai/committee/providers.server";

const goodBody = {
  schema_version: COMMITTEE_SCHEMA_VERSION,
  direction: "long",
  confidence: 0.8,
  entry_zone: { low: 100, high: 101 },
  invalidation: 98,
  tp_levels: [105, 110],
  evidence: { trend: 0.7, pivots: 0.6, volume: 0.5, liquidity: 0.4, fvg: 0.3, historical_similarity: 0.2 },
  risk_flags: ["THIN_LIQUIDITY"],
  summary: "Trend and pivots align to the upside.",
};

function ok(role: "lead" | "risk" | "structure", direction: string, confidence = 0.8, flags: string[] = []): ProviderOutcome {
  return {
    role,
    provider: "openai",
    model: "m",
    available: true,
    latencyMs: 10,
    response: { ...goodBody, direction, confidence, risk_flags: flags } as any,
  };
}
function down(role: "lead" | "risk" | "structure", reason: any = "timeout"): ProviderOutcome {
  return { role, provider: "openai", model: "m", available: false, latencyMs: 1, reason, detail: "x" };
}

const snapshot: MarketSnapshot = {
  candidate_id: "cand-1",
  strategy: "accumulator",
  symbol: "BTC-USDT",
  timeframe: "5m",
  candle_close_ms: Date.now(),
  deterministic: {
    proposed_direction: "long",
    entry: 100,
    entry_zone: null,
    invalidation: 98,
    tp_levels: [105],
    regime: "trend",
    trend_state: "up",
    trend_slope_pct: 0.2,
    atr_pct: 0.4,
    recent_closes: [99, 100],
    recent_highs: [101],
    recent_lows: [98],
    volume_profile: [10],
  },
};

describe("response schema — fails closed, never guesses", () => {
  it("accepts a well-formed versioned response", () => {
    const r = parseCommitteeResponse(JSON.stringify(goodBody));
    expect(r.ok).toBe(true);
  });

  it("tolerates a json code fence", () => {
    const r = parseCommitteeResponse("```json\n" + JSON.stringify(goodBody) + "\n```");
    expect(r.ok).toBe(true);
  });

  it("rejects malformed JSON", () => {
    const r = parseCommitteeResponse("{ direction: long, ");
    expect(r).toMatchObject({ ok: false, reason: "malformed_json" });
  });

  it("rejects prose instead of JSON", () => {
    expect(parseCommitteeResponse("I think this is a long.")).toMatchObject({
      ok: false,
      reason: "malformed_json",
    });
  });

  it("rejects an empty response", () => {
    expect(parseCommitteeResponse("")).toMatchObject({ ok: false, reason: "empty_response" });
    expect(parseCommitteeResponse(null)).toMatchObject({ ok: false, reason: "empty_response" });
  });

  it("rejects a wrong schema version", () => {
    const r = parseCommitteeResponse(JSON.stringify({ ...goodBody, schema_version: "v0" }));
    expect(r).toMatchObject({ ok: false, reason: "schema_invalid" });
  });

  it("rejects an out-of-range confidence", () => {
    expect(parseCommitteeResponse(JSON.stringify({ ...goodBody, confidence: 4 }))).toMatchObject({
      ok: false,
      reason: "schema_invalid",
    });
  });

  it("rejects an unknown direction", () => {
    expect(parseCommitteeResponse(JSON.stringify({ ...goodBody, direction: "maybe" }))).toMatchObject({
      ok: false,
      reason: "schema_invalid",
    });
  });

  it("rejects a missing evidence block", () => {
    const { evidence, ...rest } = goodBody as any;
    expect(parseCommitteeResponse(JSON.stringify(rest))).toMatchObject({
      ok: false,
      reason: "schema_invalid",
    });
  });
});

describe("aggregation — shadow verdicts only", () => {
  it("is unavailable below the minimum provider count", () => {
    const v = aggregateCommittee([ok("lead", "long"), down("risk"), down("structure")]);
    expect(v.verdict).toBe("shadow_unavailable");
    expect(v.unavailableRoles).toEqual(["risk", "structure"]);
    expect(MIN_AVAILABLE_PROVIDERS).toBe(2);
  });

  it("endorses on a confident unanimous long", () => {
    const v = aggregateCommittee([ok("lead", "long", 0.9), ok("risk", "long", 0.8), ok("structure", "long", 0.7)]);
    expect(v.verdict).toBe("shadow_endorse");
    expect(v.consensusDirection).toBe("long");
    expect(v.riskDissent).toBe(false);
  });

  it("downgrades to weak endorse when the risk officer dissents", () => {
    const v = aggregateCommittee([ok("lead", "long", 0.9), ok("risk", "short", 0.9), ok("structure", "long", 0.9)]);
    expect(v.verdict).toBe("shadow_weak_endorse");
    expect(v.riskDissent).toBe(true);
  });

  it("rejects when the majority says no_trade", () => {
    const v = aggregateCommittee([ok("lead", "no_trade"), ok("risk", "no_trade"), ok("structure", "long")]);
    expect(v.verdict).toBe("shadow_reject");
  });

  it("reports no consensus on a tie", () => {
    const v = aggregateCommittee([ok("lead", "long"), ok("risk", "short")]);
    expect(v.verdict).toBe("shadow_no_consensus");
    expect(v.consensusDirection).toBeNull();
  });

  it("survives a partial provider outage with two survivors", () => {
    const v = aggregateCommittee([ok("lead", "long", 0.9), ok("structure", "long", 0.9), down("risk", "missing_credential")]);
    expect(v.verdict).toBe("shadow_weak_endorse");
    expect(v.availableRoles).toEqual(["lead", "structure"]);
  });

  it("always marks the verdict advisory", () => {
    expect(aggregateCommittee([]).advisory).toBe(true);
    expect(aggregateCommittee([ok("lead", "long"), ok("risk", "long")]).advisory).toBe(true);
  });

  it("unions and truncates risk flags", () => {
    const v = aggregateCommittee([ok("lead", "long", 0.9, ["A", "B"]), ok("risk", "long", 0.9, ["B", "C"])]);
    expect(v.riskFlags).toEqual(["A", "B", "C"]);
  });
});

describe("provider layer — timeouts, outages, and credential isolation", () => {
  it("routes GLM directly while leaving Qwen and DeepSeek isolated", async () => {
    const env = { TURTLEBOT_ZAI_API_KEY: "zai-key", TURTLEBOT_TOGETHER_API_KEY: "together-key",
      TURTLEBOT_DEEPSEEK_API_KEY: "deepseek-key" };
    const calls: Array<{ url: string; auth: string; body: any }> = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), auth: init.headers.authorization, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(goodBody) } }] }));
    }) as any;
    await runFirstRound(snapshot, env);
    expect(calls.filter((c) => c.url.includes("api.z.ai"))).toHaveLength(1);
    expect(calls.find((c) => c.url.includes("api.z.ai"))).toMatchObject({ auth: "Bearer zai-key", body: { model: "glm-5.3", reasoning_effort: "low" } });
    expect(calls.filter((c) => c.url.includes("api.together.xyz"))).toHaveLength(1);
    expect(calls.find((c) => c.url.includes("api.together.xyz"))?.body.model).toContain("Qwen");
  });
  it("never falls back from direct GLM to a Together paid request", async () => {
    const env = { TURTLEBOT_GLM_PROVIDER: "zai", TURTLEBOT_TOGETHER_API_KEY: "together-key" };
    globalThis.fetch = vi.fn(async () => { throw new Error("must not be called"); }) as any;
    const [result] = await runFirstRound(snapshot, env, 100, {
      specs: [resolveRoleSpecs(env)[0]], allowGatewayFallback: true,
    });
    expect(result).toMatchObject({ available: false, reason: "missing_credential", provider: "zai" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("keeps provider complexity hidden and activates the lean profile only when configured", () => {
    const legacy = resolveRoleSpecs({});
    expect(legacy.map((seat) => seat.provider)).toEqual(["openai", "deepseek", "google"]);

    const lean = resolveRoleSpecs({ TURTLEBOT_TOGETHER_API_KEY: "configured" });
    expect(lean.map((seat) => seat.provider)).toEqual(["zai", "deepseek", "qwen"]);
    expect(lean.find((seat) => seat.role === "lead")?.model).toBe("zai-org/GLM-5.3-Flash");
    expect(lean.find((seat) => seat.role === "structure")?.model).toBe("Qwen/Qwen3.5-9B");
  });

  it("routes every seat through OpenRouter when its key is set, with env-overridable models", () => {
    const routed = resolveRoleSpecs({
      TURTLEBOT_OPENROUTER_API_KEY: "configured",
      TURTLEBOT_TOGETHER_API_KEY: "also-configured",
      TURTLEBOT_OPENROUTER_RISK_MODEL: "meta-llama/llama-4-maverick",
    });
    expect(routed.map((seat) => seat.provider)).toEqual(["openrouter", "openrouter", "openrouter"]);
    expect(routed.find((seat) => seat.role === "risk")?.model).toBe("meta-llama/llama-4-maverick");
  });

  it("routes lean seats through Together without exposing that key to DeepSeek", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), headers: init.headers });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(goodBody) } }] }),
        { status: 200 },
      );
    }) as any;

    await runFirstRound(snapshot, {
      TURTLEBOT_TOGETHER_API_KEY: "together-key",
      TURTLEBOT_DEEPSEEK_API_KEY: "deepseek-key",
    });

    expect(calls.filter((call) => call.url.includes("api.together.xyz"))).toHaveLength(2);
    const deepseek = calls.find((call) => call.url.includes("api.deepseek.com"));
    expect(JSON.stringify(deepseek?.headers)).not.toContain("together-key");
  });

  it("records missing_credential rather than guessing", async () => {
    const spec = resolveRoleSpecs({}).find((s) => s.role === "risk")!;
    const out = await callProvider(spec, snapshot, {});
    expect(out.available).toBe(false);
    expect((out as any).reason).toBe("missing_credential");
  });

  it("records a timeout as unavailable", async () => {
    globalThis.fetch = vi.fn(
      (_u: any, init: any) =>
        new Promise((_res, rej) => {
          init.signal.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    ) as any;
    const spec = resolveRoleSpecs({}).find((s) => s.role === "lead")!;
    const out = await callProvider(spec, snapshot, { LOVABLE_API_KEY: "k" }, 20);
    expect(out.available).toBe(false);
    expect((out as any).reason).toBe("timeout");
  });

  it("records an http error as unavailable", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 500 })) as any;
    const spec = resolveRoleSpecs({}).find((s) => s.role === "lead")!;
    const out = await callProvider(spec, snapshot, { LOVABLE_API_KEY: "k" });
    expect((out as any).reason).toBe("http_error");
  });

  it("records malformed provider JSON as unavailable", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as any;
    const spec = resolveRoleSpecs({}).find((s) => s.role === "lead")!;
    const out = await callProvider(spec, snapshot, { LOVABLE_API_KEY: "k" });
    expect((out as any).reason).toBe("malformed_json");
  });

  it("captures provider-reported tokens without storing prompt content", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(goodBody) } }],
          usage: { prompt_tokens: 120, completion_tokens: 40, prompt_cache_hit_tokens: 20 },
        }), { status: 200 }),
    ) as any;
    const spec = resolveRoleSpecs({}).find((s) => s.role === "lead")!;
    const out = await callProvider(spec, snapshot, { LOVABLE_API_KEY: "k" });
    expect(out.usage).toEqual({ inputTokens: 120, outputTokens: 40, cachedInputTokens: 20 });
    expect(JSON.stringify(out)).not.toContain(snapshot.candidate_id);
  });

  it("never leaks the API key into the recorded detail", async () => {
    const KEY = "sk-supersecretvalue-abcdefghijklmnop";
    globalThis.fetch = vi.fn(async () => {
      throw new Error(`connect failed using ${KEY}`);
    }) as any;
    const spec = resolveRoleSpecs({}).find((s) => s.role === "lead")!;
    const out = await callProvider(spec, snapshot, { LOVABLE_API_KEY: KEY });
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect((out as any).detail).toContain("[redacted]");
  });

  it("sends the Anthropic key only to Anthropic, never to the gateway", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), headers: init.headers });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(goodBody) } }] }), {
        status: 200,
      });
    }) as any;
    await runFirstRound(snapshot, {
      LOVABLE_API_KEY: "gateway-key",
      TURTLEBOT_DEEPSEEK_API_KEY: "deepseek-key",
    });
    // Key isolation is the point of the direct call: the risk seat's own
    // credential must never travel to the gateway, and vice versa.
    for (const c of calls) {
      if (c.url.includes("ai.gateway.lovable.dev")) {
        expect(JSON.stringify(c.headers)).not.toContain("deepseek-key");
      }
      if (c.url.includes("api.deepseek.com")) {
        expect(JSON.stringify(c.headers)).not.toContain("gateway-key");
      }
    }
    // And no seat may reach Anthropic at all any more.
    expect(calls.some((c) => c.url.includes("api.anthropic.com"))).toBe(false);
  });

  it("refuses to evaluate a stale snapshot", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("must not be called");
    }) as any;
    const stale = { ...snapshot, candle_close_ms: Date.now() - MAX_SNAPSHOT_AGE_MS - 1_000 };
    const outs = await runFirstRound(stale, { LOVABLE_API_KEY: "k" });
    expect(outs).toHaveLength(3);
    expect(outs.every((o) => !o.available)).toBe(true);
    expect((outs[0] as any).reason).toBe("stale_snapshot");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("gives every provider the identical snapshot (no cross-contamination)", async () => {
    const bodies: string[] = [];
    globalThis.fetch = vi.fn(async (_u: any, init: any) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(goodBody) } }] }), {
        status: 200,
      });
    }) as any;
    await runFirstRound(snapshot, { LOVABLE_API_KEY: "k", TURTLEBOT_DEEPSEEK_API_KEY: "a" });
    // Every request body embeds the byte-identical canonical snapshot.
    //
    // 3 calls, one per seat — no fallback. This was 4 when the risk seat ran
    // Anthropic: the stub here is OpenAI-shaped, Anthropic's `content[]`
    // parser could not read it, and the seat retried on the gateway. DeepSeek
    // is OpenAI-compatible, so it parses the same stub and answers first time.
    const embedded = JSON.stringify(canonicalJson(snapshot)).slice(1, -1);
    expect(bodies).toHaveLength(3);
    for (const b of bodies) expect(b).toContain(embedded);
    // No body may contain another model's answer.
    for (const b of bodies) expect(b).not.toContain(goodBody.summary);
  });

  it("runs a user-selected Council directly with isolated provider keys", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      const value = String(url);
      calls.push({ url: value, headers: init.headers });
      if (value.includes("api.anthropic.com")) {
        return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(goodBody) }] }), { status: 200 });
      }
      if (value.includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(goodBody) }] } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(goodBody) } }] }), { status: 200 });
    }) as any;

    const outs = await runFirstRound(snapshot, {}, 1_000, {
      specs: [
        { role: "lead", provider: "openai", model: "gpt-5.4", title: "lead" },
        { role: "risk", provider: "anthropic", model: "claude-sonnet-4-6", title: "risk" },
        { role: "structure", provider: "google", model: "gemini-2.5-pro", title: "structure" },
      ],
      credentials: { openai: "openai-test-key", anthropic: "anthropic-test-key", google: "google-test-key" },
      allowGatewayFallback: false,
    });

    expect(outs.every((out) => out.available)).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls.some((call) => call.url === "https://api.openai.com/v1/chat/completions")).toBe(true);
    expect(calls.some((call) => call.url === "https://api.anthropic.com/v1/messages")).toBe(true);
    expect(calls.some((call) => call.url.includes("generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro"))).toBe(true);
    expect(calls.some((call) => call.url.includes("ai.gateway.lovable.dev"))).toBe(false);
    for (const call of calls) {
      const headers = JSON.stringify(call.headers);
      if (!call.url.includes("api.openai.com")) expect(headers).not.toContain("openai-test-key");
      if (!call.url.includes("api.anthropic.com")) expect(headers).not.toContain("anthropic-test-key");
      if (!call.url.includes("generativelanguage.googleapis.com")) expect(headers).not.toContain("google-test-key");
    }
  });
});

describe("idempotency", () => {
  it("hashes identical evidence to the same digest", async () => {
    const a = await evidenceHash(snapshot);
    const b = await evidenceHash({ ...snapshot, deterministic: { ...snapshot.deterministic } });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("changes the digest when any evidence value changes", async () => {
    const a = await evidenceHash(snapshot);
    const c = await evidenceHash({
      ...snapshot,
      deterministic: { ...snapshot.deterministic, entry: 100.5 },
    });
    expect(a).not.toBe(c);
  });

  it("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
});

describe("SHADOW MODE — structural proof of zero execution authority", () => {
  const root = resolve(__dirname, "../../../..");
  const files = [
    "lib/ai/committee/providers.server.ts",
    "lib/ai/committee/aggregate.ts",
    "lib/ai/committee/schema.ts",
    "lib/ai/committee.functions.ts",
    "lib/ai/committee/dto.ts",
    "lib/ai/committee/evaluate.server.ts",
    "lib/candidate/contract.ts",
    "lib/candidate/lifecycle.ts",
    "lib/candidate/lifecycle.functions.ts",
    "hooks/useCandidateLifecycle.ts",
    "components/trade/CandidateLifecycleTimeline.tsx",
    "components/trade/CommitteePanel.tsx",
  ]
    // Strip comments and CSS custom properties so the scan sees real code
    // references only — prose like "no signer access" must not trip it.
    .map((f) => ({
      f,
      src: readFileSync(resolve(root, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1")
        .replace(/--onixus-[a-z-]+/g, ""),
    }));

  const FORBIDDEN = [
    "signer",
    "SIGNER_",
    "broker",
    "manual-deploy",
    "manual-exit",
    "submit_order",
    "submitOrder",
    "createOrder",
    "create_order",
    "cancelOrder",
    "closePosition",
    "supabaseAdmin",
    "client.server",
    "exchange_credentials",
    "SERVICE_ROLE",
    "TURTLE_CREDENTIAL_ENCRYPTION_KEY",
    "ONIXUS",
  ];

  for (const { f, src } of files) {
    it(`${f} references no execution or credential surface`, () => {
      const hits = FORBIDDEN.filter((t) => src.includes(t));
      expect(hits).toEqual([]);
    });
  }

  it("committee code writes to exactly one table, the evaluations ledger", () => {
    const fn = files.find((x) => x.f.endsWith("committee.functions.ts"))!.src;
    // Every query goes through a single table constant.
    const literals = Array.from(fn.matchAll(/\.from\(([^)]+)\)/g)).map((m) => m[1].trim());
    expect(Array.from(new Set(literals))).toEqual(["EVALUATIONS_TABLE"]);
    expect(fn).toContain('const EVALUATIONS_TABLE = "ai_committee_evaluations"');
    expect(fn).not.toMatch(/\.(update|delete|upsert)\(/);
  });

  it("the only privileged capability is an append to the evaluations ledger", () => {
    const ledger = readFileSync(resolve(root, "lib/ai/committee/ledger.server.ts"), "utf8");
    // The admin client is reachable from exactly one committee module...
    const admins = files.filter((x) => /supabaseAdmin|client\.server/.test(x.src));
    expect(admins.map((x) => x.f)).toEqual([]);
    // ...and that module performs no query of its own.
    expect(ledger).not.toMatch(/\.from\(/);
    expect(ledger).not.toMatch(/(insert|update|delete|upsert)\(/);
    for (const term of ["signer", "broker", "exchange_credentials", "submitOrder"]) {
      expect(ledger).not.toContain(term);
    }
  });

  it("the lifecycle layer only reads execution state, never mutates it", () => {
    const lifecycle = files.find((x) => x.f.endsWith("lifecycle.functions.ts"))!.src;
    expect(lifecycle).toMatch(/\.from\("order_intents"\)/);
    // Reads only: no write verb anywhere in the lifecycle server functions.
    expect(lifecycle).not.toMatch(/\.(insert|update|delete|upsert)\(/);
  });

  it("the evaluation core writes only the ledger and the shadow-state flag", () => {
    const core = files.find((x) => x.f.endsWith("evaluate.server.ts"))!.src;
    const tables = Array.from(core.matchAll(/\.from\(([^)]+)\)/g)).map((m) => m[1].trim());
    expect(Array.from(new Set(tables)).sort()).toEqual([
      "EVALUATIONS_TABLE",
      '"strategy_candidates"',
    ].sort());
    // The candidate row is only ever touched to record AI availability.
    const updates = Array.from(core.matchAll(/\.update\(([^)]*)\)/g)).map((m) => m[1]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("ai_shadow_state");
    expect(core).not.toMatch(/\.delete\(/);
  });

  it("the UI renders the persisted verdict rather than recomputing it", () => {
    const panel = files.find((x) => x.f.endsWith("CommitteePanel.tsx"))!.src;
    expect(panel).not.toContain("aggregateCommittee");
  });

  it("every persisted record is flagged advisory", () => {
    const core = files.find((x) => x.f.endsWith("evaluate.server.ts"))!.src;
    expect(core).toContain("advisory: true");
  });
});

describe("the risk seat runs DeepSeek, not Anthropic", () => {
  it("calls DeepSeek directly with its own bearer key", async () => {
    const calls: { url: string; headers: any; body: any }[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(goodBody) } }] }),
        { status: 200 },
      );
    }) as any;

    await runFirstRound(snapshot, {
      LOVABLE_API_KEY: "gateway-key",
      TURTLEBOT_DEEPSEEK_API_KEY: "ds-key",
    });

    const ds = calls.find((c) => c.url.includes("api.deepseek.com"));
    expect(ds, "the risk seat did not call DeepSeek").toBeTruthy();
    // Bearer auth, not Anthropic's x-api-key.
    expect(JSON.stringify(ds!.headers)).toContain("Bearer ds-key");
    expect(JSON.stringify(ds!.headers).toLowerCase()).not.toContain("x-api-key");
    expect(JSON.stringify(ds!.headers).toLowerCase()).not.toContain("anthropic-version");
  });

  it("sends a BARE model id, not a gateway vendor/model id", async () => {
    // `gatewayModelIdIsValid` must not be applied to this seat: it exists
    // because the gateway requires `vendor/model`, and DeepSeek is a direct
    // call that takes `deepseek-chat`. Applying it would reject every valid
    // model and surface as invalid_model_config on every evaluation.
    const calls: any[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(goodBody) } }] }),
        { status: 200 },
      );
    }) as any;

    const outs = await runFirstRound(snapshot, {
      LOVABLE_API_KEY: "k",
      TURTLEBOT_DEEPSEEK_API_KEY: "ds",
    });

    const ds = calls.find((c) => c.url.includes("api.deepseek.com"));
    expect(ds!.body.model).toBe("deepseek-chat");
    expect(ds!.body.model).not.toContain("/");
    // The seat produced a real answer rather than a config refusal.
    const risk = outs.find((o) => o.role === "risk");
    expect(risk?.available).toBe(true);
  });

  it("asks DeepSeek for a JSON object, since the contract requires one", async () => {
    const calls: any[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(goodBody) } }] }),
        { status: 200 },
      );
    }) as any;
    await runFirstRound(snapshot, { LOVABLE_API_KEY: "k", TURTLEBOT_DEEPSEEK_API_KEY: "ds" });
    const ds = calls.find((c) => c.url.includes("api.deepseek.com"));
    expect(ds!.body.response_format).toEqual({ type: "json_object" });
  });

  it("falls back to the gateway when the DeepSeek key is absent, and says so", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(goodBody) } }] }),
        { status: 200 },
      ),
    ) as any;
    // WITHOUT TURTLEBOT_DEEPSEEK_API_KEY THE SEAT DOES NOT GO DARK — it runs
    // on the gateway fallback model instead. `missing_credential` is in
    // FALLBACK_REASONS, so the committee keeps three answers.
    //
    // The cost is diversity, not availability: the risk seat then runs the
    // same vendor as the structure seat, so the adversarial check is no
    // longer independent. That is why the substitution is recorded rather
    // than hidden — the outcome carries the fallback model id.
    const outs = await runFirstRound(snapshot, { LOVABLE_API_KEY: "k" });
    const risk = outs.find((o) => o.role === "risk")!;
    expect(risk.available).toBe(true);
    expect(risk.model).toBe(FALLBACK_GATEWAY_MODEL);
    expect(risk.provider).not.toBe("deepseek");
    expect(outs.filter((o) => o.available).length).toBe(3);
  });

  it("reports the DeepSeek credential clearly when the gateway cannot rescue it", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("no network");
    }) as any;
    // No gateway key either, so nothing rescues the seat and the ORIGINAL
    // reason must survive.
    const outs = await runFirstRound(snapshot, {});
    const risk = outs.find((o) => o.role === "risk")!;
    expect(risk.available).toBe(false);
    expect((risk as any).reason).toBe("missing_credential");
    // The detail names the provider, not the env var. `unavailable()` redacts
    // any 24+ char [A-Za-z0-9_-] run and TURTLEBOT_DEEPSEEK_API_KEY is 26, so
    // embedding it produced "[redacted] is not configured" — telling an
    // operator nothing. Provider + reason identify it without a long token.
    expect((risk as any).detail).toContain("DeepSeek");
    expect((risk as any).detail).not.toContain("[redacted]");
    expect(risk.provider).toBe("deepseek");
  });
});
