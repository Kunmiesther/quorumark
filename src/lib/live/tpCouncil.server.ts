/**
 * DEFERRED TAKE-PROFIT COUNCIL — server orchestrator.
 *
 * Owner directive (2026-08-04): no take-profit is attached or submitted at
 * entry. After exactly three FULLY CLOSED execution-timeframe candles the
 * council re-reviews the position and may SET_TP, PARTIAL_TP, HOLD_WITHOUT_TP,
 * TRAIL or EXIT_NOW. Any order action is submitted as a SEPARATE reduce-only
 * order through the canonical broker -> signer path and must return a venue
 * order id.
 *
 * SAFETY PROPERTIES
 *   * Idempotent: each (position, review_seq) is claimed by inserting a row
 *     with a UNIQUE review_key. A restart mid-review re-claims nothing and
 *     therefore cannot double-review or double-submit a TP.
 *   * Reconciled: the venue position is refreshed (reconcile-live-positions)
 *     and its size is the ONLY size authority. The signer independently
 *     re-checks side and size against ApeX before submitting.
 *   * Reduce-only: every order this module can emit is reduce_only=true.
 *   * Council failure/timeout degrades to HOLD_WITHOUT_TP with another review
 *     scheduled after the next closed candle. Stop protection must be verified
 *     independently from venue orders; this module never assumes it exists.
 *   * Audited: fill timestamp, candles counted, council inputs/opinions,
 *     decision, intent key, venue order id and final state are persisted in
 *     public.live_tp_council_reviews.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { directGlmSelected, resolveGlmTransport, glmGenerationOptions } from "@/lib/ai/glmTransport.server";
import { recordRawAiUsage } from "@/lib/ai/usage.server";
import {
  DEFAULT_TIMEOUT_MS,
  resolveRoleSpecs,
  gatewayModelIdIsValid,
} from "@/lib/ai/committee/providers.server";
import {
  buildLiveSnapshot,
  type LivePositionFacts,
  type LiveSnapshot,
} from "./liveSnapshot.server";
import {
  candleProgress,
  fallbackOutcome,
  isCouncilDecision,
  nextReviewCandles,
  REQUIRED_CLOSED_CANDLES,
  reviewKey,
  stateForDecision,
  timeframeMs,
  validateTpOrder,
  type CouncilDecision,
  type CouncilOutcome,
} from "./tpCouncil";

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const TOGETHER_URL = "https://api.together.xyz/v1/chat/completions";
// Same seat, same provider as the committee and live-advisory paths.
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

export const TP_COUNCIL_PROMPT_VERSION = "tp_council.prompt.v4";

type MarketRead = "TREND_CONTINUATION" | "PULLBACK" | "REVERSAL" | "UNCLEAR";
const MARKET_READS = new Set<MarketRead>(["TREND_CONTINUATION", "PULLBACK", "REVERSAL", "UNCLEAR"]);

interface PortfolioContext {
  position_id: string;
  symbol: string;
  side: string;
  size: number;
  venue_leverage: number | null;
  notional_usd: number;
  unrealized_pnl_usd: number | null;
  visible_stop_order: boolean;
}

interface PreviousReview {
  review_seq: number;
  decision: string | null;
  rationale: string | null;
  completed_at: string | null;
  mark_price: number | null;
  market_read: string | null;
  venue_order_id: string | null;
}

export function priorReviewFeedback(
  row: {
    review_seq?: unknown;
    decision?: unknown;
    rationale?: unknown;
    completed_at?: unknown;
    venue_order_id?: unknown;
    council_inputs?: unknown;
  } | null,
  currentMark: number | null,
  direction: "long" | "short",
): (PreviousReview & { favorable_move_pct: number | null }) | null {
  if (!row) return null;
  const inputs =
    row.council_inputs && typeof row.council_inputs === "object"
      ? (row.council_inputs as Record<string, unknown>)
      : {};
  const priorMark = positive(inputs.mark_price) ?? null;
  const favorableMove =
    priorMark && currentMark && Number.isFinite(currentMark)
      ? Number(
          (((currentMark - priorMark) / priorMark) * 100 * (direction === "long" ? 1 : -1)).toFixed(
            4,
          ),
        )
      : null;
  return {
    review_seq: Number(row.review_seq) || 0,
    decision: typeof row.decision === "string" ? row.decision : null,
    rationale: typeof row.rationale === "string" ? row.rationale : null,
    completed_at: typeof row.completed_at === "string" ? row.completed_at : null,
    mark_price: priorMark,
    market_read: typeof inputs.market_read === "string" ? inputs.market_read : null,
    venue_order_id: typeof row.venue_order_id === "string" ? row.venue_order_id : null,
    favorable_move_pct: favorableMove,
  };
}

function visibleStopOrder(orders: unknown): boolean {
  return (
    Array.isArray(orders) &&
    orders.some((order) => {
      if (!order || typeof order !== "object") return false;
      const data = order as Record<string, unknown>;
      const type = String(data.type ?? data.orderType ?? data.order_type ?? "").toUpperCase();
      return type.includes("STOP") && data.reduceOnly !== false && data.reduce_only !== false;
    })
  );
}

const APEX_SYMBOLS_URL = "https://omni.apex.exchange/api/v3/symbols";

interface VenueGeometry {
  tickSize: number;
  stepSize: number;
  minOrderSize: number | undefined;
  minNotional: number | undefined;
}

const positive = (value: unknown): number | undefined => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Parse current venue increments; missing fields never become guessed defaults. */
export function apexVenueGeometry(body: unknown, symbol: string): VenueGeometry | null {
  if (!body || typeof body !== "object") return null;
  const data = (body as { data?: { contractConfig?: { perpetualContract?: unknown } } }).data;
  const rows = data?.contractConfig?.perpetualContract;
  if (!Array.isArray(rows)) return null;
  const target = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const row = rows.find((item) => {
    if (!item || typeof item !== "object") return false;
    const contract = item as Record<string, unknown>;
    return [contract.symbol, contract.crossSymbolName, contract.symbolDisplayName].some(
      (name) => typeof name === "string" && name.toUpperCase().replace(/[^A-Z0-9]/g, "") === target,
    );
  }) as Record<string, unknown> | undefined;
  if (!row || row.enableTrade === false || row.enableOpenPosition === false) return null;
  const tickSize = positive(row.tickSize);
  const stepSize = positive(row.stepSize);
  if (!tickSize || !stepSize) return null;
  return {
    tickSize,
    stepSize,
    minOrderSize: positive(row.minOrderSize),
    minNotional: positive(row.minNotional ?? row.minNotionalValue),
  };
}

async function loadVenueConfig(): Promise<unknown> {
  const response = await fetch(APEX_SYMBOLS_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`venue_symbols_http_${response.status}`);
  return response.json();
}

async function originalPositionThesis(
  supabase: SupabaseClient,
  row: PositionRow,
): Promise<unknown> {
  const embedded = row.strategy_metadata?.["thesis"];
  if (embedded) return embedded;
  const decisionId = row.strategy_metadata?.["decision_id"];
  if (typeof decisionId !== "string" || !row.connection_id) return null;
  const { data, error } = await supabase
    .from("strategy_decisions")
    .select("strategy,direction,timeframe,reason,reason_code,invalidation,entry_zone,evidence")
    .eq("decision_id", decisionId)
    .eq("user_id", row.user_id)
    .eq("connection_id", row.connection_id)
    .eq("symbol", row.pair)
    .eq("direction", String(row.side).toLowerCase())
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

interface PositionRow {
  id: string;
  exchange_connections: { exchange: string } | null;
  user_id: string;
  connection_id: string | null;
  pair: string;
  side: string;
  size: number;
  entry_price: number;
  mark_price: number | null;
  current_price: number;
  leverage: number | null;
  liquidation_price: number | null;
  unrealized_pnl: number | null;
  opened_at: string;
  synced_at: string | null;
  open_orders: unknown;
  strategy_metadata: Record<string, unknown> | null;
  tp_state: string;
  tp_review_seq: number;
  tp_candles_required: number;
  tp_execution_timeframe: string;
  tp_fill_ts: string | null;
}

const REVIEWABLE_STATES = new Set(["PENDING_COUNCIL_REVIEW", "HOLD_WITHOUT_TP", "TRAILING"]);

function systemPrompt(role: string): string {
  const charter: Record<string, string> = {
    lead: "You are the LEAD STRATEGIST seat. Judge whether the original thesis still holds.",
    risk: "You are the RISK GUARDIAN seat. Assume the position is wrong; prefer capital preservation.",
    structure:
      "You are the MARKET STRUCTURE ANALYST seat. Judge trend integrity, pivots, FVGs, liquidity and volatility.",
  };
  return (
    `${charter[role] ?? charter["lead"]}\n\n` +
    "Review one ALREADY OPEN live position using the fresh venue and market evidence supplied. " +
    "Classify the move as trend continuation, a genuine pullback, a possible reversal, or unclear. " +
    "A single adverse candle is not proof of reversal: compare confirmed swings, ATR distance, " +
    "volume, 5m/15m structure, higher timeframes, and the original thesis. " +
    "Treat snapshot.structure_read as fallible evidence, not a decision. A reclaimed sweep " +
    "can be a fakeout rather than reversal; require confirming structure and risk evidence. " +
    "A 'press' posture means consider holding, never add size or leverage. " +
    "The review trigger is a clock, not a predetermined trade decision. " +
    "Never assume that an entry stop, take-profit, or trailing order exists; use only visible venue order evidence. " +
    "Compare the previous review with what price actually did, but do not treat one favorable move as proof the prior decision was optimal. " +
    "Consider simultaneous positions and correlated exposure before deciding the take-profit posture.\n\n" +
    "Answer with JSON ONLY:\n" +
    '{"market_state":"TREND_CONTINUATION|PULLBACK|REVERSAL|UNCLEAR",' +
    '"decision":"SET_TP|PARTIAL_TP|HOLD_WITHOUT_TP|EXIT_NOW",' +
    '"price":<absolute price or null>,"size_fraction":<0-1 or null>,' +
    '"trail_pct":null,"confidence":<0-1>,"rationale":"<one sentence>"}\n\n' +
    "Rules: SET_TP and PARTIAL_TP REQUIRE an absolute price on the profitable side " +
    "of the current mark. PARTIAL_TP REQUIRES size_fraction. " +
    "EXIT_NOW closes the whole position at market. If the evidence is ambiguous, " +
    "answer HOLD_WITHOUT_TP. Do not describe an unverified stop as protection."
  );
}

function userPrompt(
  snapshot: LiveSnapshot,
  thesis: unknown,
  candles: number,
  portfolio: PortfolioContext[],
  previousReview: ReturnType<typeof priorReviewFeedback>,
): string {
  return JSON.stringify(
    {
      prompt_version: TP_COUNCIL_PROMPT_VERSION,
      closed_candles_since_fill: candles,
      original_thesis: thesis ?? null,
      venue_protection: {
        open_order_count: snapshot.position.open_order_count,
        visible_stop_order:
          portfolio.find((row) => row.position_id === snapshot.position.position_id)
            ?.visible_stop_order ?? false,
        note: "An absent visible order is unverified protection, not proof that an attached stop exists or does not exist.",
      },
      simultaneous_positions: portfolio,
      previous_review_feedback: previousReview,
      snapshot,
    },
    null,
    0,
  );
}

function extractText(_provider: string, body: unknown): string | null {
  // One wire format now — Anthropic's `content[]` shape was the only reason
  // this branched.
  const content = (body as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]
    ?.message?.content;
  return typeof content === "string" && content ? content : null;
}

export interface SeatOpinion {
  role: string;
  model: string;
  available: boolean;
  decision: CouncilDecision | null;
  price: number | null;
  size_fraction: number | null;
  trail_pct: number | null;
  confidence: number | null;
  market_state: MarketRead | null;
  rationale: string;
  unavailable_reason?: string;
  latency_ms: number;
}

function parseSeat(
  text: string | null,
): Omit<SeatOpinion, "role" | "model" | "latency_ms" | "available"> | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const decision = raw["decision"];
  if (!isCouncilDecision(decision)) return null;
  const marketState = raw["market_state"];
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    decision,
    price: num(raw["price"]),
    size_fraction: num(raw["size_fraction"]),
    trail_pct: num(raw["trail_pct"]),
    confidence: num(raw["confidence"]),
    market_state: MARKET_READS.has(marketState as MarketRead) ? (marketState as MarketRead) : null,
    rationale: typeof raw["rationale"] === "string" ? raw["rationale"].slice(0, 400) : "",
  };
}

async function callSeat(
  spec: { role: string; provider: string; model: string },
  snapshot: LiveSnapshot,
  thesis: unknown,
  candles: number,
  portfolio: PortfolioContext[],
  previousReview: ReturnType<typeof priorReviewFeedback>,
  env: Record<string, string | undefined>,
  userId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<SeatOpinion> {
  const started = Date.now();
  const base = { role: spec.role, model: spec.model };
  const unavailable = (reason: string): SeatOpinion => ({
    ...base,
    available: false,
    decision: null,
    price: null,
    size_fraction: null,
    trail_pct: null,
    confidence: null,
    market_state: null,
    rationale: "",
    unavailable_reason: reason,
    latency_ms: Date.now() - started,
  });

  let url: string;
  let headers: Record<string, string>;
  let payload: Record<string, unknown>;
  if (spec.provider === "deepseek") {
    const key = env["TURTLEBOT_DEEPSEEK_API_KEY"];
    if (!key) return unavailable("missing_credential");
    // Direct call, bare model id — deliberately not gatewayModelIdIsValid.
    url = DEEPSEEK_URL;
    headers = { "content-type": "application/json", authorization: `Bearer ${key}` };
    payload = {
      model: spec.model,
      max_tokens: 900,
      messages: [
        { role: "system", content: systemPrompt(spec.role) },
        { role: "user", content: userPrompt(snapshot, thesis, candles, portfolio, previousReview) },
      ],
      response_format: { type: "json_object" },
    };
  } else if (spec.provider === "zai" && directGlmSelected(env)) {
    const glm = resolveGlmTransport(env);
    if (!glm.apiKey) return unavailable("missing_credential");
    url = glm.url;
    headers = { "content-type": "application/json", authorization: `Bearer ${glm.apiKey}` };
    payload = {
      model: spec.model, ...glmGenerationOptions({ ...glm, model: spec.model }, 900),
      messages: [
        { role: "system", content: systemPrompt(spec.role) },
        { role: "user", content: userPrompt(snapshot, thesis, candles, portfolio, previousReview) },
      ],
      response_format: { type: "json_object" },
    };
  } else if (spec.provider === "zai" || spec.provider === "qwen") {
    if (!gatewayModelIdIsValid(spec.model)) return unavailable("invalid_model_config");
    const key = env["TURTLEBOT_TOGETHER_API_KEY"];
    if (!key) return unavailable("missing_credential");
    url = TOGETHER_URL;
    headers = { "content-type": "application/json", authorization: `Bearer ${key}` };
    payload = {
      model: spec.model,
      max_tokens: 900,
      messages: [
        { role: "system", content: systemPrompt(spec.role) },
        { role: "user", content: userPrompt(snapshot, thesis, candles, portfolio, previousReview) },
      ],
      response_format: { type: "json_object" },
    };
  } else {
    if (!gatewayModelIdIsValid(spec.model)) return unavailable("invalid_model_config");
    const key = env["LOVABLE_API_KEY"];
    if (!key) return unavailable("missing_credential");
    url = GATEWAY_URL;
    headers = { "content-type": "application/json", "Lovable-API-Key": key };
    payload = {
      model: spec.model,
      messages: [
        { role: "system", content: systemPrompt(spec.role) },
        { role: "user", content: userPrompt(snapshot, thesis, candles, portfolio, previousReview) },
      ],
      response_format: { type: "json_object" },
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      await recordRawAiUsage({
        userId,
        feature: "tp_council",
        provider: spec.provider,
        model: spec.model,
        status: "error",
        latencyMs: Date.now() - started,
      });
      return unavailable(`http_${r.status}`);
    }
    const body = await r.json();
    const parsed = parseSeat(extractText(spec.provider, body));
    await recordRawAiUsage({
      userId,
      feature: "tp_council",
      provider: spec.provider,
      model: spec.model,
      status: parsed ? "success" : "error",
      latencyMs: Date.now() - started,
      body,
    });
    if (!parsed) return unavailable("unparsable_response");
    return { ...base, available: true, latency_ms: Date.now() - started, ...parsed };
  } catch {
    await recordRawAiUsage({
      userId,
      feature: "tp_council",
      provider: spec.provider,
      model: spec.model,
      status: ctrl.signal.aborted ? "timeout" : "error",
      latencyMs: Date.now() - started,
    });
    return unavailable(ctrl.signal.aborted ? "timeout" : "http_error");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deterministic synthesis (ONYX). Code decides, not a model:
 *   * a live order requires at least two available seats;
 *   * EXIT_NOW requires two independent votes; one dissenting exit vote
 *     prevents any other order action and triggers a hold for review;
 *   * otherwise the modal decision across available seats wins;
 *   * ties and empty councils fall back to HOLD_WITHOUT_TP;
 *   * price for SET_TP/PARTIAL_TP is the MEDIAN of the seats that voted for
 *     the winning decision and supplied a price. No price -> HOLD.
 */
export function synthesize(opinions: SeatOpinion[]): CouncilOutcome {
  const seats = opinions.filter((o) => o.available && o.decision);
  if (seats.length < 2) return fallbackOutcome("insufficient_seat_quorum");

  const exitVotes = seats.filter((o) => o.decision === "EXIT_NOW");
  if (exitVotes.length >= 2) {
    return {
      decision: "EXIT_NOW",
      rationale: exitVotes[0]?.rationale || "Two Council seats called for an immediate exit.",
    };
  }
  if (exitVotes.length === 1) return fallbackOutcome("exit_vote_disagreement");

  const tally = new Map<CouncilDecision, number>();
  for (const o of seats) tally.set(o.decision!, (tally.get(o.decision!) ?? 0) + 1);
  let winner: CouncilDecision = "HOLD_WITHOUT_TP";
  let best = 0;
  for (const [d, n] of tally) {
    if (n > best) {
      best = n;
      winner = d;
    } else if (n === best && d !== winner) {
      winner = "HOLD_WITHOUT_TP";
    }
  }

  const backing = seats.filter((o) => o.decision === winner);
  const rationale = backing[0]?.rationale || "Council synthesis.";

  if (winner === "SET_TP" || winner === "PARTIAL_TP") {
    const prices = backing
      .map((o) => o.price)
      .filter((p): p is number => typeof p === "number" && p > 0)
      .sort((a, b) => a - b);
    if (!prices.length) return fallbackOutcome("no_price_supplied");
    const price = prices[Math.floor(prices.length / 2)];
    const fractions = backing
      .map((o) => o.size_fraction)
      .filter((f): f is number => typeof f === "number" && f > 0 && f <= 1);
    const sizeFraction =
      winner === "PARTIAL_TP" ? (fractions.length ? Math.min(...fractions) : 0.5) : 1;
    return { decision: winner, price, sizeFraction, rationale };
  }

  if (winner === "TRAIL") {
    const trails = backing
      .map((o) => o.trail_pct)
      .filter((t): t is number => typeof t === "number" && t > 0);
    if (!trails.length) return fallbackOutcome("no_trail_distance");
    return { decision: "TRAIL", trailPct: Math.min(...trails), rationale };
  }

  return { decision: "HOLD_WITHOUT_TP", rationale };
}

/** Disagreement remains visible instead of being presented as a reversal fact. */
export function marketReadConsensus(opinions: SeatOpinion[]): MarketRead {
  const reads = opinions
    .filter((opinion) => opinion.available && opinion.market_state)
    .map((opinion) => opinion.market_state!);
  if (!reads.length) return "UNCLEAR";
  const tally = new Map<MarketRead, number>();
  for (const read of reads) tally.set(read, (tally.get(read) ?? 0) + 1);
  let winner: MarketRead = "UNCLEAR";
  let count = 0;
  for (const [read, votes] of tally) {
    if (votes > count) {
      winner = read;
      count = votes;
    } else if (votes === count) winner = "UNCLEAR";
  }
  return count > reads.length / 2 ? winner : "UNCLEAR";
}

// --- Canonical order submission -----------------------------------------

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`)
    .join(",")}}`;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface BrokerResult {
  status: string;
  exchange_order_id: string | null;
  reject_reason: string | null;
}

/**
 * Submit ONE reduce-only order through the canonical broker. Never called
 * with reduce_only anything but true — this module has no entry authority.
 */
type ReviewExitIntent = {
  venue: "apex_omni" | "aster";
  idempotency_key: string;
  user_id: string;
  connection_id: string;
  symbol: string;
  side: "BUY" | "SELL";
  order_type: "LIMIT" | "MARKET";
  size: string;
  price: string | null;
};
export function reduceOnlyReviewPayload(intent: ReviewExitIntent) {
  return {
    ...intent,
    size: Number(intent.size),
    price: intent.price === null ? null : Number(intent.price),
    reduce_only: true, // NON-NEGOTIABLE
    is_live: true,
    purpose: "CLOSE_POSITION",
  };
}
async function submitReduceOnly(
  env: Record<string, string | undefined>,
  intent: ReviewExitIntent,
): Promise<BrokerResult> {
  const brokerUrl = env["TURTLE_BROKER_BASE_URL"]?.trim().replace(/\/$/, "");
  const secret = env["BROKER_SIGNING_SECRET"];
  if (!brokerUrl || !secret) {
    return { status: "rejected", exchange_order_id: null, reject_reason: "BROKER_NOT_CONFIGURED" };
  }
  const payload = reduceOnlyReviewPayload(intent);
  const body = canonicalJson(payload);
  const path = "/v1/automation/orders";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const signature = await hmacHex(secret, `${timestamp}\n${nonce}\n${path}\n${body}`);
  try {
    const r = await fetch(`${brokerUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-timestamp": timestamp,
        "x-worker-nonce": nonce,
        "x-worker-signature": signature,
      },
      body,
    });
    const text = await r.text().catch(() => "");
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = {};
    }
    return {
      status: String(json["status"] ?? "rejected"),
      exchange_order_id: (json["exchange_order_id"] as string | null) ?? null,
      reject_reason:
        (json["reject_reason"] as string | null) ??
        (r.ok ? null : `BROKER_HTTP_${r.status}:${String(json["message"] ?? "").slice(0, 60)}`),
    };
  } catch (e) {
    return {
      status: "rejected",
      exchange_order_id: null,
      reject_reason:
        e instanceof Error ? `BROKER_CALL_FAILED:${e.message.slice(0, 60)}` : "BROKER_CALL_FAILED",
    };
  }
}

// --- Sweep ---------------------------------------------------------------

export interface TpCouncilSweepResult {
  scanned: number;
  due: number;
  reviewed: number;
  skipped_not_due: number;
  skipped_claimed: number;
  submitted: number;
  errors: string[];
}

interface ReconciliationResult {
  connection_id?: string;
  ok?: boolean;
  skipped?: string;
  open_orders_readable?: boolean;
  position_snapshot_ok?: boolean;
}

/** Only a complete position + open-order venue read authorizes an order. */
export function freshlyReconciledConnections(payload: unknown): Set<string> {
  if (!payload || typeof payload !== "object") return new Set();
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) return new Set();
  return new Set(
    results
      .filter(
        (result): result is ReconciliationResult =>
          !!result &&
          typeof result === "object" &&
          (result.position_snapshot_ok === true || result.ok === true) &&
          !result.skipped &&
          result.open_orders_readable === true &&
          typeof result.connection_id === "string",
      )
      .map((result) => result.connection_id!),
  );
}

export async function runTpCouncilSweep(
  supabase: SupabaseClient,
  env: Record<string, string | undefined>,
  nowMs: number = Date.now(),
): Promise<TpCouncilSweepResult> {
  const out: TpCouncilSweepResult = {
    scanned: 0,
    due: 0,
    reviewed: 0,
    skipped_not_due: 0,
    skipped_claimed: 0,
    submitted: 0,
    errors: [],
  };

  // Refresh venue truth BEFORE deciding anything. A stale-but-recent row is
  // not enough to authorize an order after this sweep's venue read fails.
  let reconciledConnections = new Set<string>();
  try {
    const reconciliation = await supabase.functions.invoke("reconcile-live-positions", {
      body: {},
      ...(env["SUPABASE_SECRET_KEY"] ? { headers: { apikey: env["SUPABASE_SECRET_KEY"] } } : {}),
    });
    if (reconciliation.error) {
      out.errors.push("reconcile_live_positions_failed");
    } else {
      reconciledConnections = freshlyReconciledConnections(reconciliation.data);
    }
  } catch {
    out.errors.push("reconcile_live_positions_failed");
  }

  const { data, error } = await supabase
    .from("positions")
    .select(
      "id,user_id,connection_id,pair,side,size,entry_price,mark_price,current_price,leverage," +
        "liquidation_price,unrealized_pnl,opened_at,synced_at,open_orders,strategy_metadata," +
        "tp_state,tp_review_seq,tp_candles_required,tp_execution_timeframe,tp_fill_ts,exchange_connections(exchange)",
    )
    .eq("source", "live")
    .eq("status", "open");
  if (error) {
    out.errors.push(`positions_read:${error.message.slice(0, 120)}`);
    return out;
  }

  const rows = (data ?? []) as unknown as PositionRow[];
  out.scanned = rows.length;

  const portfolios = new Map<string, PortfolioContext[]>();
  let venueConfigPromise: Promise<unknown> | null = null;
  for (const position of rows) {
    const positions = portfolios.get(position.user_id) ?? [];
    const mark = Number(position.mark_price ?? position.current_price ?? position.entry_price);
    positions.push({
      position_id: position.id,
      symbol: position.pair,
      side: String(position.side).toLowerCase(),
      size: Number(position.size),
      venue_leverage: position.leverage === null ? null : Number(position.leverage),
      notional_usd: Number((Number(position.size) * mark).toFixed(2)),
      unrealized_pnl_usd: position.unrealized_pnl === null ? null : Number(position.unrealized_pnl),
      visible_stop_order: visibleStopOrder(position.open_orders),
    });
    portfolios.set(position.user_id, positions);
  }

  for (const row of rows) {
    if (!REVIEWABLE_STATES.has(row.tp_state)) continue;
    const timeframe = row.tp_execution_timeframe || "5m";
    let tfMs: number;
    try {
      tfMs = timeframeMs(timeframe);
    } catch {
      out.errors.push(`${row.id}:bad_timeframe`);
      continue;
    }
    const fillIso = row.tp_fill_ts ?? row.opened_at;
    const fillMs = Date.parse(fillIso);
    if (!Number.isFinite(fillMs)) {
      out.errors.push(`${row.id}:bad_fill_ts`);
      continue;
    }

    // A HOLD re-review waits for one more closed candle on top of the
    // candles already counted at the previous review.
    const required =
      row.tp_state === "PENDING_COUNCIL_REVIEW"
        ? row.tp_candles_required || REQUIRED_CLOSED_CANDLES
        : (row.tp_candles_required || REQUIRED_CLOSED_CANDLES) + row.tp_review_seq;
    const progress = candleProgress(fillMs, nowMs, timeframe, required);
    if (!progress.due) {
      out.skipped_not_due++;
      continue;
    }
    out.due++;

    const seq = row.tp_review_seq + 1;
    const key = reviewKey(row.id, seq);

    // ---- Idempotent claim. A UNIQUE violation means another worker (or a
    // pre-restart run) already owns this review. Never re-run it.
    const { data: claim, error: claimErr } = await supabase
      .from("live_tp_council_reviews")
      .insert({
        position_id: row.id,
        user_id: row.user_id,
        review_key: key,
        review_seq: seq,
        timeframe,
        fill_ts: new Date(fillMs).toISOString(),
        candles_counted: progress.closed,
        status: "in_progress",
      })
      .select("id")
      .single();
    if (claimErr || !claim) {
      out.skipped_claimed++;
      continue;
    }
    const reviewId = claim.id as string;

    await supabase.from("positions").update({ tp_state: "REVIEW_IN_PROGRESS" }).eq("id", row.id);

    const direction: "long" | "short" =
      String(row.side).toLowerCase() === "short" ? "short" : "long";
    const mark = Number(row.mark_price ?? row.current_price ?? 0);
    const facts: LivePositionFacts = {
      position_id: row.id,
      exchange: row.exchange_connections?.exchange ?? "",
      symbol: row.pair,
      direction,
      size: Number(row.size),
      entry_price: Number(row.entry_price),
      mark_price: mark || null,
      leverage: row.leverage === null ? null : Number(row.leverage),
      liquidation_price: row.liquidation_price === null ? null : Number(row.liquidation_price),
      unrealized_pnl: row.unrealized_pnl === null ? null : Number(row.unrealized_pnl),
      unrealized_pnl_pct: null,
      opened_at: row.opened_at,
      open_order_count: Array.isArray(row.open_orders) ? row.open_orders.length : 0,
    };

    let opinions: SeatOpinion[] = [];
    let outcome: CouncilOutcome;
    let snapshot: LiveSnapshot | null = null;
    let thesis: unknown = null;
    const { data: previousRow } = await supabase
      .from("live_tp_council_reviews")
      .select("review_seq,decision,rationale,completed_at,venue_order_id,council_inputs")
      .eq("position_id", row.id)
      .eq("user_id", row.user_id)
      .eq("status", "completed")
      .order("review_seq", { ascending: false })
      .limit(1)
      .maybeSingle();
    const previousReview = priorReviewFeedback(previousRow, mark || null, direction);
    try {
      snapshot = await buildLiveSnapshot(facts, nowMs);
      thesis = await originalPositionThesis(supabase, row);
      const specs = resolveRoleSpecs(env);
      opinions = await Promise.all(
        specs.map((s) =>
          callSeat(
            { role: s.role, provider: s.provider, model: s.model },
            snapshot!,
            thesis,
            progress.closed,
            portfolios.get(row.user_id) ?? [],
            previousReview,
            env,
            row.user_id,
          ),
        ),
      );
      outcome = synthesize(opinions);
    } catch (e) {
      outcome = fallbackOutcome(e instanceof Error ? e.message.slice(0, 60) : "snapshot_failed");
    }

    // ---- Order actions --------------------------------------------------
    let brokerResult: BrokerResult | null = null;
    let rejectReason: string | null = null;
    let finalState = stateForDecision(outcome.decision);
    let submittedPrice: number | null = null;
    let submittedSize: number | null = null;

    const venueSize = Number(row.size);
    const stale = !row.synced_at || nowMs - Date.parse(row.synced_at) > 10 * 60_000;
    const executionVenue =
      facts.exchange === "aster" || facts.exchange === "apex_omni" ? facts.exchange : null;

    if (outcome.decision !== "HOLD_WITHOUT_TP" && outcome.decision !== "TRAIL") {
      if (!row.connection_id) {
        rejectReason = "NO_CONNECTION";
        finalState = "HOLD_WITHOUT_TP";
      } else if (!executionVenue) {
        rejectReason = "REVIEW_EXECUTION_VENUE_UNSUPPORTED";
        finalState = "HOLD_WITHOUT_TP";
      } else if (stale || !reconciledConnections.has(row.connection_id)) {
        // Never place a reduce-only order against an unreconciled position.
        rejectReason = "POSITION_NOT_RECONCILED";
        finalState = "HOLD_WITHOUT_TP";
      } else if (outcome.decision === "EXIT_NOW") {
        submittedSize = venueSize;
        brokerResult = await submitReduceOnly(env, {
          venue: executionVenue,
          idempotency_key: key,
          user_id: row.user_id,
          connection_id: row.connection_id,
          symbol: row.pair,
          side: direction === "long" ? "SELL" : "BUY",
          order_type: "MARKET",
          size: String(venueSize),
          price: null,
        });
      } else if (executionVenue === "aster") {
        // The current Aster broker supports reduce-only MARKET exits, not
        // resting limit TPs. Do not apply ApeX increments or relabel the venue.
        rejectReason = "ASTER_LIMIT_TP_NOT_CONNECTED";
        finalState = "HOLD_WITHOUT_TP";
      } else {
        let geometry: VenueGeometry | null = null;
        try {
          venueConfigPromise ??= loadVenueConfig();
          geometry = apexVenueGeometry(await venueConfigPromise, row.pair);
        } catch {
          // The venue config is required for a limit TP; no local defaults.
        }
        if (!geometry) {
          rejectReason = "VENUE_GEOMETRY_UNVERIFIED";
          finalState = "HOLD_WITHOUT_TP";
        } else {
          const wanted =
            outcome.decision === "PARTIAL_TP"
              ? venueSize * (outcome.sizeFraction ?? 0.5)
              : venueSize;
          const check = validateTpOrder({
            side: direction,
            price: outcome.price ?? 0,
            markPrice: mark,
            positionSize: venueSize,
            size: wanted,
            tickSize: geometry.tickSize,
            stepSize: geometry.stepSize,
            minOrderSize: geometry.minOrderSize,
            minNotional: geometry.minNotional,
          });
          if (!check.ok) {
            rejectReason = `TP_INVALID:${check.reason}`;
            finalState = "HOLD_WITHOUT_TP";
          } else {
            submittedPrice = Number(check.price);
            submittedSize = Number(check.size);
            brokerResult = await submitReduceOnly(env, {
              venue: executionVenue,
              idempotency_key: key,
              user_id: row.user_id,
              connection_id: row.connection_id,
              symbol: row.pair,
              side: check.side,
              order_type: "LIMIT",
              size: check.size,
              price: check.price,
            });
          }
        }
      }
    }

    if (brokerResult) {
      if (brokerResult.status === "submitted" || brokerResult.status === "duplicate") {
        out.submitted++;
      } else {
        // An unacknowledged order leaves the position managed by its stop and
        // re-reviewed next candle. It NEVER records a TP it does not have.
        rejectReason = brokerResult.reject_reason ?? "VENUE_REJECTED";
        finalState = "HOLD_WITHOUT_TP";
        submittedPrice = null;
        submittedSize = null;
      }
    }

    const venueOrderId = brokerResult?.exchange_order_id ?? null;

    await supabase
      .from("live_tp_council_reviews")
      .update({
        status: "completed",
        decision: outcome.decision,
        decision_price: submittedPrice,
        decision_size: submittedSize,
        rationale: outcome.rationale.slice(0, 600),
        degraded: outcome.degraded === true,
        council_inputs: {
          prompt_version: TP_COUNCIL_PROMPT_VERSION,
          timeframe,
          candles_counted: progress.closed,
          candles_required: required,
          snapshot_as_of_ms: snapshot?.as_of_ms ?? null,
          market_data_exchange: facts.exchange || null,
          environment_available: snapshot?.environment_available ?? false,
          mark_price: mark,
          venue_size: venueSize,
          market_read: marketReadConsensus(opinions),
          simultaneous_position_count: (portfolios.get(row.user_id) ?? []).length,
          visible_stop_order: visibleStopOrder(row.open_orders),
          original_thesis_available: thesis !== null,
          previous_review_seq: previousReview?.review_seq ?? null,
        },
        council_opinions: opinions,
        intent_idempotency_key: brokerResult ? key : null,
        venue_order_id: venueOrderId,
        reject_reason: rejectReason,
        final_state: finalState,
        completed_at: new Date().toISOString(),
      })
      .eq("id", reviewId);

    const patch: Record<string, unknown> = {
      tp_state: finalState,
      tp_review_seq: seq,
      tp_last_decision: outcome.decision,
      tp_last_reviewed_at: new Date().toISOString(),
      tp_fill_ts: new Date(fillMs).toISOString(),
    };
    if (venueOrderId && submittedPrice !== null) {
      patch["tp_price"] = submittedPrice;
      patch["tp_venue_order_id"] = venueOrderId;
    }
    await supabase.from("positions").update(patch).eq("id", row.id);

    out.reviewed++;
    // A decision that schedules nothing (EXIT_NOW) needs no further review.
    void nextReviewCandles(outcome.decision);
  }

  return out;
}
