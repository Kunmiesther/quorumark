/** ARC historical review: advisory only, with no execution-system imports. */
import { z } from "zod";
import { resolveGlmTransport, glmGenerationOptions } from "@/lib/ai/glmTransport.server";
import type { MarketSnapshot } from "@/lib/ai/committee/schema";

const allocationMaxPct = 5;
const evidenceSchema = z.object({
  trend: z.number().min(0).max(1), pivots: z.number().min(0).max(1),
  volume: z.number().min(0).max(1), liquidity: z.number().min(0).max(1),
  fvg: z.number().min(0).max(1), volatility: z.number().min(0).max(1),
  historical_similarity: z.number().min(0).max(1),
});
const planSchema = z.object({
  capital_allocation_pct: z.number().min(0).max(allocationMaxPct),
  leverage: z.number().min(1).max(100),
  entries: z.array(z.object({ offset_pct: z.number(), weight_pct: z.number().min(0).max(100) })).min(1),
  take_profits: z.array(z.object({ price: z.number().positive(), close_pct: z.number().min(0).max(100) })).min(1),
  hard_stop_price: z.number().positive(),
  trailing_stop: z.object({
    activate_price: z.number().positive(), distance_pct: z.number().positive(), step_pct: z.number().positive(),
  }),
}).superRefine((value, ctx) => {
  const entryTotal = value.entries.reduce((sum, row) => sum + row.weight_pct, 0);
  const exitTotal = value.take_profits.reduce((sum, row) => sum + row.close_pct, 0);
  if (Math.abs(entryTotal - 100) > 0.01) ctx.addIssue({ code: "custom", message: "entry weights must total 100" });
  if (Math.abs(exitTotal - 100) > 0.01) ctx.addIssue({ code: "custom", message: "take-profit weights must total 100" });
});
const answerSchema = z.object({
  direction: z.enum(["long", "short", "no_trade"]), confidence: z.number().min(0).max(1),
  evidence: evidenceSchema, risk_flags: z.array(z.string()), summary: z.string().max(600),
  plan: planSchema.nullable(),
}).superRefine((value, ctx) => {
  if ((value.direction === "no_trade") !== (value.plan === null)) {
    ctx.addIssue({ code: "custom", message: "no_trade must have a null plan" });
  }
});

const answerJsonSchema = {
  type: "object", additionalProperties: false,
  required: ["direction", "confidence", "evidence", "risk_flags", "summary", "plan"],
  properties: {
    direction: { type: "string", enum: ["long", "short", "no_trade"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: {
      type: "object", additionalProperties: false,
      required: ["trend", "pivots", "volume", "liquidity", "fvg", "volatility", "historical_similarity"],
      properties: Object.fromEntries(["trend", "pivots", "volume", "liquidity", "fvg", "volatility", "historical_similarity"].map((key) => [key, { type: "number", minimum: 0, maximum: 1 }])),
    },
    risk_flags: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    plan: {
      anyOf: [
        { type: "null" },
        {
          type: "object", additionalProperties: false,
          required: ["capital_allocation_pct", "leverage", "entries", "take_profits", "hard_stop_price", "trailing_stop"],
          properties: {
            capital_allocation_pct: { type: "number", minimum: 0, maximum: allocationMaxPct },
            leverage: { type: "number", minimum: 1, maximum: 100 },
            entries: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["offset_pct", "weight_pct"], properties: { offset_pct: { type: "number" }, weight_pct: { type: "number", minimum: 0, maximum: 100 } } } },
            take_profits: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["price", "close_pct"], properties: { price: { type: "number", exclusiveMinimum: 0 }, close_pct: { type: "number", minimum: 0, maximum: 100 } } } },
            hard_stop_price: { type: "number", exclusiveMinimum: 0 },
            trailing_stop: { type: "object", additionalProperties: false, required: ["activate_price", "distance_pct", "step_pct"], properties: { activate_price: { type: "number", exclusiveMinimum: 0 }, distance_pct: { type: "number", exclusiveMinimum: 0 }, step_pct: { type: "number", exclusiveMinimum: 0 } } },
          },
        },
      ],
    },
  },
};

type Answer = z.infer<typeof answerSchema>;
type Outcome = { role: string; provider: string; model: string; available: boolean; latency_ms: number; response?: Answer; reason?: string };

const seats = [
  { role: "lead", provider: "together", model: "zai-org/GLM-5.3", charter: "Build the strongest evidence-backed thesis and complete deployment geometry." },
  { role: "risk", provider: "deepseek", model: "deepseek-chat", charter: "Attack invalidation, liquidation geometry, volatility, and reward/risk. Reduce size or reject when necessary." },
  { role: "structure", provider: "together", model: "Qwen/Qwen3.5-9B", charter: "Judge pivots, BOS, sweeps, liquidity, FVGs, volume, targets, and trailing structure." },
] as const;

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("malformed_json");
  return JSON.parse(text.slice(start, end + 1));
}

function prompt(role: string, charter: string): string {
  return `You are the ${role} seat in Onyx ARC. Review one historical opportunity Zen did not open. This is shadow analysis only. ${charter}
Use only supplied evidence: multi-timeframe regime, momentum, ATR/volatility, pivots, break/retest structure, liquidity sweeps, FVGs inferable from candles, volume, reward/risk, and historical-pattern similarity. Never use future candles or invent news/order-book data.
Choose your own sizing, entry ladder, profit targets, hard stop, and trailing stop. Margin allocation may be 0% to ${allocationMaxPct}% of a $2,500 shadow wallet and leverage may not exceed 100x. For a long, every take-profit and trailing activation price must be above the supplied entry and the hard stop must be below it. For a short, every take-profit and trailing activation price must be below the supplied entry and the hard stop must be above it. Unclear invalidation means no_trade.
Return one JSON object only with direction long|short|no_trade, confidence 0..1, evidence scores trend/pivots/volume/liquidity/fvg/volatility/historical_similarity, risk_flags, summary, and plan. A non-null plan contains capital_allocation_pct, leverage, entries[{offset_pct,weight_pct}] totaling 100, take_profits[{price,close_pct}] totaling 100, hard_stop_price, trailing_stop{activate_price,distance_pct,step_pct}. no_trade requires plan:null.`;
}

async function callSeat(seat: typeof seats[number], snapshot: MarketSnapshot): Promise<Outcome> {
  const glm = resolveGlmTransport(process.env);
  const provider = seat.role === "lead" ? glm.provider : seat.provider;
  const key = seat.role === "lead" ? glm.apiKey : seat.provider === "deepseek" ? process.env.TURTLEBOT_DEEPSEEK_API_KEY : process.env.TURTLEBOT_TOGETHER_API_KEY;
  const model = seat.role === "lead" ? glm.model : seat.role === "structure" ? process.env.TURTLEBOT_QWEN_MODEL || seat.model : process.env.TURTLEBOT_DEEPSEEK_MODEL || seat.model;
  if (!key) return { role: seat.role, provider, model, available: false, latency_ms: 0, reason: "missing_credential" };
  const url = seat.role === "lead" ? glm.url : seat.provider === "deepseek" ? "https://api.deepseek.com/chat/completions" : "https://api.together.xyz/v1/chat/completions";
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55_000);
  try {
    const response = await fetch(url, {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, ...(seat.role === "lead" ? glmGenerationOptions(glm, 4096) : { max_tokens: 4096 }), response_format: provider === "together" ? { type: "json_schema", json_schema: { name: "arc_review", schema: answerJsonSchema } } : { type: "json_object" }, ...(provider === "together" ? { reasoning: { enabled: false } } : {}), messages: [
        { role: "system", content: prompt(seat.role, seat.charter) },
        { role: "user", content: `Immutable snapshot:\n${JSON.stringify(snapshot)}` },
      ] }),
    });
    if (!response.ok) return { role: seat.role, provider, model, available: false, latency_ms: Date.now() - started, reason: `http_${response.status}` };
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const parsed = answerSchema.safeParse(extractJson(body.choices?.[0]?.message?.content || ""));
    if (!parsed.success) return { role: seat.role, provider, model, available: false, latency_ms: Date.now() - started, reason: "schema_invalid" };
    const entry = Number(snapshot.deterministic.entry);
    const plan = parsed.data.plan;
    const geometryValid = parsed.data.direction === "no_trade" || !!plan && (
      parsed.data.direction === "long"
        ? plan.hard_stop_price < entry && plan.trailing_stop.activate_price > entry && plan.take_profits.every((target) => target.price > entry)
        : plan.hard_stop_price > entry && plan.trailing_stop.activate_price < entry && plan.take_profits.every((target) => target.price < entry)
    );
    if (!Number.isFinite(entry) || !geometryValid) return { role: seat.role, provider, model, available: false, latency_ms: Date.now() - started, reason: "geometry_invalid" };
    return { role: seat.role, provider, model, available: true, latency_ms: Date.now() - started, response: parsed.data };
  } catch {
    return { role: seat.role, provider, model, available: false, latency_ms: Date.now() - started, reason: controller.signal.aborted ? "timeout" : "request_failed" };
  } finally { clearTimeout(timer); }
}

function aggregate(outcomes: Outcome[]) {
  const available = outcomes.filter((row): row is Outcome & { response: Answer } => row.available && !!row.response);
  if (available.length < 2) return { verdict: "unavailable", direction: null, confidence: null, selected_plan: null };
  const groups = new Map<string, typeof available>();
  for (const row of available) groups.set(row.response.direction, [...(groups.get(row.response.direction) || []), row]);
  const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  if (!ranked[0] || ranked[0][1].length === ranked[1]?.[1].length) return { verdict: "no_consensus", direction: null, confidence: null, selected_plan: null };
  const [direction, voters] = ranked[0];
  const confidence = voters.reduce((sum, row) => sum + row.response.confidence, 0) / voters.length;
  if (direction === "no_trade") return { verdict: "reject", direction, confidence, selected_plan: null };
  const risk = available.find((row) => row.role === "risk");
  const riskDissent = !!risk && risk.response.direction !== direction;
  const planSource = voters.find((row) => row.role === "lead") || voters.find((row) => row.role === "structure") || voters[0];
  return { verdict: riskDissent || confidence < 0.66 ? "weak_endorse" : "endorse", direction, confidence, risk_dissent: riskDissent, selected_plan: planSource.response.plan, plan_source_role: planSource.role };
}

function unusedOpportunityDca(snapshot: MarketSnapshot) {
  const direction = snapshot.deterministic.proposed_direction;
  const adverseSign = direction === "long" ? -1 : 1;
  const entry = Number(snapshot.deterministic.entry);
  return {
    strategy: "unused_opportunity_dca",
    direction,
    margin_allocation_pct: 2,
    entries: [0, 0.5, 1, 1.5, 2].map((distance, index) => ({
      rung: index + 1,
      offset_pct: adverseSign * distance,
      weight_pct: 20,
    })),
    target_net_margin_roi_pct: 30,
    invalidation_price: entry * (1 + adverseSign * 0.04),
    maximum_holding_hours: 72,
    maximum_active_campaigns: 5,
    one_active_campaign_per_symbol: true,
    execution: "shadow_only",
    reason: "council_did_not_select_plan",
  };
}

export async function reviewArcSnapshot(snapshot: MarketSnapshot) {
  const outcomes = await Promise.all(seats.map((seat) => callSeat(seat, snapshot)));
  const onyx = aggregate(outcomes);
  return {
    candidate_id: snapshot.candidate_id,
    advisory: true,
    outcomes,
    onyx: {
      ...onyx,
      fallback_dca: onyx.selected_plan ? null : unusedOpportunityDca(snapshot),
    },
  };
}
