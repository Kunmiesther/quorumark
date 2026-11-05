const seats = [
  ["lead", "together", "TURTLEBOT_TOGETHER_API_KEY", "TURTLEBOT_GLM_MODEL", "zai-org/GLM-5.3", "Build the strongest evidence-backed thesis and complete deployment geometry."],
  ["risk", "deepseek", "TURTLEBOT_DEEPSEEK_API_KEY", "TURTLEBOT_DEEPSEEK_MODEL", "deepseek-chat", "Attack invalidation, liquidation geometry, volatility, and reward/risk. Reduce size or reject."],
  ["structure", "together", "TURTLEBOT_TOGETHER_API_KEY", "TURTLEBOT_QWEN_MODEL", "Qwen/Qwen3.5-9B", "Judge pivots, BOS, sweeps, liquidity, FVGs, volume, targets, and trailing structure."],
];

const answerJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["direction", "confidence", "evidence", "risk_flags", "summary", "plan"],
  properties: {
    direction: { type: "string", enum: ["long", "short", "no_trade"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: {
      type: "object", additionalProperties: false,
      required: ["trend", "pivots", "volume", "liquidity", "fvg", "volatility", "historical_similarity"],
      properties: Object.fromEntries(["trend", "pivots", "volume", "liquidity", "fvg", "volatility", "historical_similarity"].map(key => [key, { type: "number", minimum: 0, maximum: 1 }])),
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
            capital_allocation_pct: { type: "number", minimum: 0, maximum: 5 },
            leverage: { type: "number", minimum: 1, maximum: 100 },
            entries: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["offset_pct", "weight_pct"], properties: { offset_pct: { type: "number" }, weight_pct: { type: "number" } } } },
            take_profits: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["price", "close_pct"], properties: { price: { type: "number" }, close_pct: { type: "number" } } } },
            hard_stop_price: { type: "number" },
            trailing_stop: { type: "object", additionalProperties: false, required: ["activate_price", "distance_pct", "step_pct"], properties: { activate_price: { type: "number" }, distance_pct: { type: "number" }, step_pct: { type: "number" } } },
          },
        },
      ],
    },
  },
};

function prompt(role, charter) {
  return `You are the ${role} seat in Onyx ARC. Review one historical opportunity Zen did not open. Shadow analysis only. ${charter}
Use only supplied evidence: multi-timeframe regime, momentum, ATR/volatility, pivots, break/retest structure, liquidity sweeps, FVGs inferable from candles, volume, reward/risk, and historical-pattern similarity. Never use future candles or invent news/order-book data.
Choose your own sizing, entry ladder, profit targets, hard stop, and trailing stop. Margin allocation is 0% to 5% of a $2,500 shadow wallet. Leverage cannot exceed 100x. For a long, every take-profit and trailing activation price must be above the supplied entry and the hard stop must be below it. For a short, every take-profit and trailing activation price must be below the supplied entry and the hard stop must be above it. Unclear invalidation means no_trade.
Return one JSON object only: {"direction":"long|short|no_trade","confidence":0..1,"evidence":{"trend":0..1,"pivots":0..1,"volume":0..1,"liquidity":0..1,"fvg":0..1,"volatility":0..1,"historical_similarity":0..1},"risk_flags":[],"summary":"two sentences max","plan":null|{"capital_allocation_pct":0..5,"leverage":1..100,"entries":[{"offset_pct":number,"weight_pct":number}],"take_profits":[{"price":number,"close_pct":number}],"hard_stop_price":number,"trailing_stop":{"activate_price":number,"distance_pct":number,"step_pct":number}}}. Entry and exit weights must each total 100. no_trade requires plan:null.`;
}

function extract(text) {
  const start = text.indexOf("{"); const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("malformed_json");
  return JSON.parse(text.slice(start, end + 1));
}

function valid(a, snapshot) {
  if (!a || !["long", "short", "no_trade"].includes(a.direction) || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1) return false;
  if (a.direction === "no_trade") return a.plan === null;
  const p = a.plan;
  if (!p || !Number.isFinite(p.capital_allocation_pct) || p.capital_allocation_pct < 0 || p.capital_allocation_pct > 5 || !Number.isFinite(p.leverage) || p.leverage < 1 || p.leverage > 100) return false;
  if (!Array.isArray(p.entries) || !p.entries.length || !Array.isArray(p.take_profits) || !p.take_profits.length) return false;
  const ew = p.entries.reduce((n, x) => n + Number(x.weight_pct || 0), 0);
  const tw = p.take_profits.reduce((n, x) => n + Number(x.close_pct || 0), 0);
  const entry = Number(snapshot?.deterministic?.entry);
  const geometry = a.direction === "long"
    ? p.hard_stop_price < entry && p.trailing_stop?.activate_price > entry && p.take_profits.every(x => x.price > entry)
    : p.hard_stop_price > entry && p.trailing_stop?.activate_price < entry && p.take_profits.every(x => x.price < entry);
  return Math.abs(ew - 100) <= .01 && Math.abs(tw - 100) <= .01 && Number.isFinite(entry) && Number.isFinite(p.hard_stop_price) && p.trailing_stop && Number.isFinite(p.trailing_stop.activate_price) && p.trailing_stop.distance_pct > 0 && p.trailing_stop.step_pct > 0 && geometry;
}

function invalidDetail(a) {
  if (!a || typeof a !== "object") return "answer_not_object";
  if (!["long", "short", "no_trade"].includes(a.direction)) return `direction=${String(a.direction).slice(0, 24)}`;
  if (!Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1) return `confidence=${String(a.confidence).slice(0, 24)}`;
  if (a.direction === "no_trade") return `no_trade_plan=${a.plan === null ? "null" : typeof a.plan}`;
  const p = a.plan;
  if (!p) return "missing_plan";
  if (!Number.isFinite(p.capital_allocation_pct) || p.capital_allocation_pct < 0 || p.capital_allocation_pct > 5) return `allocation=${String(p.capital_allocation_pct).slice(0, 24)}`;
  if (!Number.isFinite(p.leverage) || p.leverage < 1 || p.leverage > 100) return `leverage=${String(p.leverage).slice(0, 24)}`;
  if (!Array.isArray(p.entries) || !p.entries.length) return "entries_missing";
  if (!Array.isArray(p.take_profits) || !p.take_profits.length) return "take_profits_missing";
  const ew = p.entries.reduce((n, x) => n + Number(x.weight_pct || 0), 0);
  const tw = p.take_profits.reduce((n, x) => n + Number(x.close_pct || 0), 0);
  if (Math.abs(ew - 100) > .01) return `entry_weight_total=${ew}`;
  if (Math.abs(tw - 100) > .01) return `exit_weight_total=${tw}`;
  if (!Number.isFinite(p.hard_stop_price)) return `hard_stop=${String(p.hard_stop_price).slice(0, 24)}`;
  if (!p.trailing_stop) return "trailing_stop_missing";
  if (![p.trailing_stop.activate_price, p.trailing_stop.distance_pct, p.trailing_stop.step_pct].every(Number.isFinite)) return "trailing_stop_invalid";
  return "unknown_schema_error";
}

async function callSeat(seat, snapshot) {
  const [role, provider, keyName, modelName, fallbackModel, charter] = seat;
  const key = process.env[keyName]; const model = process.env[modelName] || fallbackModel;
  if (!key) return { role, provider, model, available: false, reason: "missing_credential", latency_ms: 0 };
  const url = provider === "deepseek" ? "https://api.deepseek.com/chat/completions" : "https://api.together.xyz/v1/chat/completions";
  const started = Date.now(); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 55000);
  try {
    const responseFormat = provider === "together"
      ? { type: "json_schema", json_schema: { name: "arc_review", schema: answerJsonSchema } }
      : { type: "json_object" };
    const response = await fetch(url, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ model, max_tokens: 4096, response_format: responseFormat, ...(provider === "together" ? { reasoning: { enabled: false } } : {}), messages: [{ role: "system", content: prompt(role, charter) }, { role: "user", content: `Immutable snapshot:\n${JSON.stringify(snapshot)}` }] }) });
    if (!response.ok) {
      let detail = "";
      try {
        const failed = await response.json();
        detail = String(failed?.error?.message || failed?.message || "").replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]").slice(0, 180);
      } catch { /* status is sufficient */ }
      return { role, provider, model, available: false, reason: `http_${response.status}`, detail, latency_ms: Date.now() - started };
    }
    const body = await response.json();
    let answer;
    try { answer = extract(body?.choices?.[0]?.message?.content || ""); }
    catch {
      const message = body?.choices?.[0]?.message;
      return { role, provider, model, available: false, reason: "malformed_json", detail: `content_length=${String(message?.content || "").length}; finish=${String(body?.choices?.[0]?.finish_reason || "unknown").slice(0, 40)}`, latency_ms: Date.now() - started };
    }
    if (!valid(answer, snapshot)) return { role, provider, model, available: false, reason: "schema_invalid", detail: invalidDetail(answer), latency_ms: Date.now() - started };
    return { role, provider, model, available: true, response: answer, usage: body.usage || null, latency_ms: Date.now() - started };
  } catch { return { role, provider, model, available: false, reason: controller.signal.aborted ? "timeout" : "request_failed", latency_ms: Date.now() - started }; }
  finally { clearTimeout(timer); }
}

function aggregate(outcomes) {
  const ok = outcomes.filter(x => x.available);
  if (ok.length < 2) return { verdict: "unavailable", direction: null, confidence: null, selected_plan: null };
  const groups = {}; for (const x of ok) (groups[x.response.direction] ||= []).push(x);
  const ranked = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
  if (!ranked[0] || ranked[0][1].length === ranked[1]?.[1].length) return { verdict: "no_consensus", direction: null, confidence: null, selected_plan: null };
  const [direction, voters] = ranked[0]; const confidence = voters.reduce((n, x) => n + x.response.confidence, 0) / voters.length;
  if (direction === "no_trade") return { verdict: "reject", direction, confidence, selected_plan: null };
  const risk = ok.find(x => x.role === "risk"); const riskDissent = !!risk && risk.response.direction !== direction;
  const source = voters.find(x => x.role === "lead") || voters.find(x => x.role === "structure") || voters[0];
  return { verdict: riskDissent || confidence < .66 ? "weak_endorse" : "endorse", direction, confidence, risk_dissent: riskDissent, selected_plan: source.response.plan, plan_source_role: source.role };
}

export default async function handler(request, response) {
  if (request.method !== "POST") return response.status(405).json({ ok: false });
  const snapshot = request.body;
  if (!snapshot?.candidate_id?.startsWith("ARC-") || !["BTC-USDT", "ETH-USDT", "SOL-USDT"].includes(snapshot.symbol)) return response.status(400).json({ ok: false });
  const outcomes = await Promise.all(seats.map(seat => callSeat(seat, snapshot)));
  return response.status(200).json({ ok: true, candidate_id: snapshot.candidate_id, advisory: true, outcomes, onyx: aggregate(outcomes) });
}
