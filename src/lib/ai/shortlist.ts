/**
 * SCOUT-WIDE COMMITTEE SHORTLIST — pure, deterministic, no I/O.
 *
 * AUTHORITY: NONE by itself. This module decides which candidates are worth
 * asking the strategists about, how the same-cycle shortlist is normalized and
 * ranked, and which single candidate (if any) is put forward. Whatever it
 * selects still has to pass every downstream gate — entitlement, risk,
 * balance, precision, idempotency, live allowlist and exchange
 * acknowledgement. It can never force a trade: when nothing clears the
 * threshold it returns an explicit NO TRADE reason instead.
 *
 * Everything here is total and referentially transparent so the ranking can be
 * replayed from persisted rows.
 */
import { ORCHESTRATION } from "@/lib/paper/parityConstants";

export const SHORTLIST_STRATEGY_VERSION = "shortlist.v1";

export type Direction = "long" | "short";

export type ShortlistState =
  | "reviewing"
  | "degraded"
  | "selected"
  | "rejected"
  | "no_trade";

/** Deterministic prefilter policy. Tightening these reduces throughput;
 *  loosening them is explicitly NOT how throughput is meant to grow. */
export const PREFILTER_POLICY = {
  /** Minimum 24h quote volume / book depth proxy, USD. */
  minLiquidityUsd: 2_000_000,
  /** Maximum acceptable half-spread cost, basis points. */
  maxSpreadBps: 8,
  /** Volatility floor — a dead tape has no edge to capture. Expressed as
   *  ATR percent of price ON THE CYCLE TIMEFRAME (5m), where a normal major
   *  reads 0.05–0.20 and a dead book reads under 0.03. */
  minVolatilityPct: 0.03,
  /** Volatility ceiling — beyond this, slippage assumptions break. */
  maxVolatilityPct: 3,
  /** A candidate whose signal candle is older than this is stale. */
  maxSignalAgeMs: 15 * 60_000,
  /** Venue must support at least this much leverage to be tradeable here. */
  minExchangeMaxLeverage: 2,
  /** Hard cap on how many candidates are fanned out to the strategists. */
  maxBatch: 12,
  /** Maximum simultaneous candidates per symbol (both sides never both run). */
  maxPerSymbol: 1,
} as const;

/** Round-trip taker fee assumption, basis points. */
export const ROUND_TRIP_FEE_BPS = 10;

/**
 * How far a trade is expected to reach, in ATR units of the cycle timeframe.
 * Matches the 1/2/3-ATR take-profit ladder the deterministic read proposes,
 * so the edge estimate is measured against the geometry actually used rather
 * than against a single candle's range.
 */
export const EDGE_ATR_MULTIPLE = 3;

/** Minimum normalized score required before a candidate may be selected. */
export const SELECTION_THRESHOLD = 0.55;

/** Fewer available strategists than this and the candidate cannot be ranked. */
export const MIN_AVAILABLE_SEATS = 2;
export const TOTAL_SEATS = 3;

export interface PrefilterCandidate {
  symbol: string;
  direction: Direction;
  signalId: string;
  /** ms epoch of the closed candle the signal was derived from. */
  candleCloseMs: number;
  contractActive: boolean;
  liquidityUsd: number | null;
  spreadBps: number | null;
  volatilityPct: number | null;
  exchangeMaxLeverage: number | null;
  tickSize: number | null;
  stepSize: number | null;
  minNotionalUsd: number | null;
  confidence: number | null;
  momentum: number | null;
  structure: number | null;
}

export interface PrefilterRejection {
  symbol: string;
  direction: Direction;
  reason: string;
}

export interface PrefilterResult {
  accepted: PrefilterCandidate[];
  rejected: PrefilterRejection[];
}

export interface PrefilterContext {
  nowMs: number;
  /** Symbols the account already has exposure to — capacity/correlation. */
  openSymbols?: ReadonlySet<string>;
  /** Signal ids already turned into candidates — duplicate suppression. */
  alreadySeenSignalIds?: ReadonlySet<string>;
  /** Remaining concurrent-position capacity. 0 blocks the whole batch. */
  remainingCapacity?: number;
  maxBatch?: number;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Deterministic prefilter. Runs BEFORE any model is asked anything, so model
 * budget is never spent on a market that could not have been traded anyway.
 * Ordering is stable: score-independent, sorted by (symbol, direction).
 */
export function prefilterCandidates(
  input: readonly PrefilterCandidate[],
  ctx: PrefilterContext,
): PrefilterResult {
  const accepted: PrefilterCandidate[] = [];
  const rejected: PrefilterRejection[] = [];
  const seenSymbols = new Set<string>();
  const seenSignals = new Set<string>(ctx.alreadySeenSignalIds ?? []);
  const open = ctx.openSymbols ?? new Set<string>();
  const capacity = ctx.remainingCapacity ?? Number.POSITIVE_INFINITY;
  const maxBatch = Math.max(1, ctx.maxBatch ?? PREFILTER_POLICY.maxBatch);

  const ordered = [...input].sort(
    (a, b) => a.symbol.localeCompare(b.symbol) || a.direction.localeCompare(b.direction),
  );

  for (const c of ordered) {
    const reject = (reason: string) => rejected.push({ symbol: c.symbol, direction: c.direction, reason });

    if (!c.contractActive) { reject("contract_inactive"); continue; }
    if (seenSignals.has(c.signalId)) { reject("duplicate_candidate"); continue; }
    if (!Number.isFinite(c.candleCloseMs) || c.candleCloseMs <= 0) { reject("no_closed_candle"); continue; }
    if (ctx.nowMs - c.candleCloseMs > PREFILTER_POLICY.maxSignalAgeMs) { reject("stale_candle"); continue; }

    const liq = num(c.liquidityUsd);
    if (liq == null || liq < PREFILTER_POLICY.minLiquidityUsd) { reject("insufficient_liquidity"); continue; }

    const spread = num(c.spreadBps);
    if (spread != null && spread > PREFILTER_POLICY.maxSpreadBps) { reject("spread_too_wide"); continue; }

    const vol = num(c.volatilityPct);
    if (vol != null && (vol < PREFILTER_POLICY.minVolatilityPct || vol > PREFILTER_POLICY.maxVolatilityPct)) {
      reject("volatility_out_of_band");
      continue;
    }

    const lev = num(c.exchangeMaxLeverage);
    if (lev != null && lev < PREFILTER_POLICY.minExchangeMaxLeverage) { reject("leverage_unsupported"); continue; }

    if (!(num(c.tickSize) != null && num(c.stepSize) != null)) { reject("precision_unknown"); continue; }

    if (open.has(c.symbol)) { reject("existing_exposure"); continue; }
    if (seenSymbols.size >= capacity) { reject("capacity_exhausted"); continue; }
    if (seenSymbols.has(c.symbol)) { reject("correlated_duplicate_symbol"); continue; }
    if (accepted.length >= maxBatch) { reject("batch_cap_reached"); continue; }

    seenSymbols.add(c.symbol);
    seenSignals.add(c.signalId);
    accepted.push(c);
  }

  return { accepted, rejected };
}

/** One strategist's recorded decision, provider-neutral. */
export interface SeatDecision {
  /** Internal seat id: lead | risk | structure. Display names live in roles.ts. */
  role: string;
  available: boolean;
  direction: Direction | "no_trade" | null;
  confidence: number | null;
  reason: string | null;
}

export interface ReviewedCandidate extends PrefilterCandidate {
  seats: SeatDecision[];
  verdict: string | null;
  consensusDirection: Direction | "no_trade" | null;
  consensusConfidence: number | null;
  riskFlags: string[];
  candidateId?: string | null;
  evaluationId?: string | null;
  evidenceHash?: string | null;
}

export interface ScoreComponents {
  liquidity: number;
  momentum: number;
  structure: number;
  net_edge: number;
  agreement: number;
  risk_penalty: number;
}

export interface RankedCandidate {
  symbol: string;
  direction: Direction;
  state: ShortlistState;
  rank: number | null;
  totalScore: number;
  components: ScoreComponents;
  expectedNetEdgeBps: number;
  availableSeats: number;
  unavailableSeats: number;
  riskVeto: boolean;
  /** Full classification: hard vs discretionary, confidence, penalty, reason. */
  riskObjection: RiskObjection;

  rejectionReason: string | null;
  seats: SeatDecision[];
  verdict: string | null;
  consensusConfidence: number | null;
  liquidityUsd: number | null;
  spreadBps: number | null;
  volatilityPct: number | null;
  signalId: string;
  candidateId: string | null;
  evaluationId: string | null;
  evidenceHash: string | null;
}

export interface RankingResult {
  ranked: RankedCandidate[];
  selected: RankedCandidate | null;
  noTradeReason: string | null;
}

/** Weights sum to 1 across positive terms; risk is a subtractive penalty. */
export const RANK_WEIGHTS = {
  liquidity: 0.2,
  momentum: 0.15,
  structure: 0.15,
  net_edge: 0.25,
  agreement: 0.25,
  risk_penalty: 0.25,
} as const;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** Min-max normalize within the cycle. All-equal batches map to 0.5 so a
 *  single-candidate cycle is not artificially scored 0 or 1. */
export function normalizeWithin(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  const finite = values.map((v) => (Number.isFinite(v) ? v : 0));
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (max - min < 1e-12) return finite.map(() => 0.5);
  return finite.map((v) => (v - min) / (max - min));
}

/**
 * Expected net edge in basis points: the move the committee expects to
 * capture, minus round-trip fees and the observed spread as a slippage proxy.
 *
 * This is a SCORING input only (see `net_edge` in `RANK_WEIGHTS`), not a hard
 * gate — a candidate with a thin or negative modeled edge still competes on
 * the composite score rather than being rejected outright. On 15m candles near
 * the volatility floor, gross edge is often barely above cost, and a hard
 * `edges[i] <= 0` cutoff here was rejecting most candidates before the
 * strategists' own agreement/structure read ever got a say.
 */
export function expectedNetEdgeBps(c: ReviewedCandidate, feeBps = ROUND_TRIP_FEE_BPS): number {
  const vol = num(c.volatilityPct) ?? 0;
  const conf = clamp01(num(c.consensusConfidence) ?? num(c.confidence) ?? 0);
  const grossBps = vol * 100 * EDGE_ATR_MULTIPLE * conf;
  const spread = Math.max(0, num(c.spreadBps) ?? 0);
  return grossBps - feeBps - spread;
}

function seatAgreement(c: ReviewedCandidate): number {
  const answered = c.seats.filter((s) => s.available);
  if (answered.length === 0) return 0;
  const agreeing = answered.filter((s) => s.direction === c.direction).length;
  const ratio = agreeing / answered.length;
  // Participation matters: a 2/2 agreement with a missing seat cannot score
  // like a 3/3 agreement.
  const participation = answered.length / TOTAL_SEATS;
  const conf = clamp01(num(c.consensusConfidence) ?? 0);
  return clamp01(ratio * participation * (0.5 + 0.5 * conf));
}

/**
 * Risk objections that are ALWAYS binding regardless of stated confidence.
 * These are objective failures, not discretionary market opinions: if the
 * Risk seat raises one, the candidate is dead for the cycle.
 */
export const HARD_VETO_FLAGS: ReadonlySet<string> = new Set([
  "STALE_DATA",
  "STALE_SNAPSHOT",
  "INVALID_GEOMETRY",
  "NO_INVALIDATION",
  "INSUFFICIENT_LIQUIDITY",
  "EXCESSIVE_SLIPPAGE",
  "BALANCE_BREACH",
  "EXPOSURE_BREACH",
  "LIQUIDATION_CONFLICT",
  "UNSUPPORTED_SYMBOL",
  "CATASTROPHIC_RISK",
  "PROMPT_INJECTION",
]);

/**
 * Confidence at or above which a discretionary Risk objection becomes a real
 * veto. Below it the objection is a scoring penalty: a hedged "I'd rather not"
 * must not silently kill a strong two-seat consensus.
 */
export const RISK_VETO_CONFIDENCE = 0.5;

/** Penalty applied when a discretionary objection is downgraded. */
export const DISCRETIONARY_RISK_PENALTY = 0.35;

export interface RiskObjection {
  /** The risk seat objected at all (no_trade or opposite direction). */
  objected: boolean;
  /** Binding: removes the candidate from selection. */
  veto: boolean;
  /** Hard failure (always binding) vs discretionary market opinion. */
  classification: "none" | "hard" | "discretionary";
  confidence: number | null;
  /** Additive penalty contributed to the risk component of the score. */
  penalty: number;
  /** Specific structured reason, persisted verbatim. */
  reason: string | null;
  /** Hard flags that triggered a binding veto, if any. */
  flags: string[];
}

function normalizeFlag(f: string): string {
  return f.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

/**
 * Classify the Risk Guardian's position on a candidate.
 *
 * Hard failures stay absolutely binding. A discretionary no-trade opinion
 * below `RISK_VETO_CONFIDENCE` becomes a score penalty; at or above it, the
 * seat may veto with its own structured reason.
 */
export function classifyRiskObjection(c: ReviewedCandidate): RiskObjection {
  const risk = c.seats.find((s) => s.role === "risk");
  const flags = (c.riskFlags ?? []).map(normalizeFlag).filter((f) => HARD_VETO_FLAGS.has(f));

  if (!risk?.available) {
    return {
      objected: false, veto: false, classification: "none",
      confidence: null, penalty: 0.2, reason: null, flags,
    };
  }

  const conf = num(risk.confidence);
  const objected = risk.direction === "no_trade" || (!!risk.direction && risk.direction !== c.direction);

  if (flags.length > 0) {
    return {
      objected: true, veto: true, classification: "hard",
      confidence: conf, penalty: 1, reason: risk.reason ?? `hard_risk_failure:${flags.join(",")}`,
      flags,
    };
  }
  if (!objected) {
    return { objected: false, veto: false, classification: "none", confidence: conf, penalty: 0, reason: null, flags };
  }

  const binding = (conf ?? 0) >= RISK_VETO_CONFIDENCE;
  return {
    objected: true,
    veto: binding,
    classification: "discretionary",
    confidence: conf,
    penalty: binding ? 0.6 : DISCRETIONARY_RISK_PENALTY,
    reason: risk.reason ?? (binding ? "risk_guardian_discretionary_veto" : "risk_guardian_low_confidence_objection"),
    flags,
  };
}

function riskPenalty(c: ReviewedCandidate): number {
  const objection = classifyRiskObjection(c);
  let p = objection.penalty;
  p += Math.min(0.3, c.riskFlags.length * 0.1);
  return clamp01(p);
}

/** Binding Risk Guardian veto — hard failure, or a confident discretionary no. */
export function hasRiskVeto(c: ReviewedCandidate): boolean {
  return classifyRiskObjection(c).veto;
}


/**
 * Rank the ENTIRE same-cycle shortlist against itself and pick at most one
 * candidate. Ties break on score desc, then symbol asc, then direction asc —
 * fully deterministic.
 */
export function rankShortlist(
  reviewed: readonly ReviewedCandidate[],
  opts: { threshold?: number } = {},
): RankingResult {
  const threshold = opts.threshold ?? SELECTION_THRESHOLD;
  if (reviewed.length === 0) {
    return { ranked: [], selected: null, noTradeReason: "no_qualified_candidates" };
  }

  const liqNorm = normalizeWithin(reviewed.map((c) => Math.log10(Math.max(1, num(c.liquidityUsd) ?? 1))));
  const edges = reviewed.map((c) => expectedNetEdgeBps(c));
  const edgeNorm = normalizeWithin(edges);

  const ranked: RankedCandidate[] = reviewed.map((c, i) => {
    const availableSeats = c.seats.filter((s) => s.available).length;
    const unavailableSeats = c.seats.length - availableSeats;
    const components: ScoreComponents = {
      liquidity: clamp01(liqNorm[i]),
      momentum: clamp01(num(c.momentum) ?? 0),
      structure: clamp01(num(c.structure) ?? 0),
      net_edge: clamp01(edgeNorm[i]),
      agreement: seatAgreement(c),
      risk_penalty: riskPenalty(c),
    };
    const total = clamp01(
      components.liquidity * RANK_WEIGHTS.liquidity +
        components.momentum * RANK_WEIGHTS.momentum +
        components.structure * RANK_WEIGHTS.structure +
        components.net_edge * RANK_WEIGHTS.net_edge +
        components.agreement * RANK_WEIGHTS.agreement -
        components.risk_penalty * RANK_WEIGHTS.risk_penalty,
    );

    const objection = classifyRiskObjection(c);
    const veto = objection.veto;
    // Two non-risk seats that both back the proposed side carry the cycle even
    // when the aggregate verdict reads no_trade because of a hedged Risk seat.
    const backing = c.seats.filter(
      (s) => s.role !== "risk" && s.available && s.direction === c.direction,
    ).length;
    const twoSeatConsensus = backing >= 2;
    let state: ShortlistState = "reviewing";
    let rejectionReason: string | null = null;
    if (availableSeats === 0) {
      state = "rejected";
      rejectionReason = "no_strategist_response";
    } else if (availableSeats < MIN_AVAILABLE_SEATS) {
      state = "rejected";
      rejectionReason = "insufficient_reviews";
    } else if (veto) {
      state = "rejected";
      rejectionReason =
        objection.classification === "hard"
          ? `risk_guardian_hard_veto:${objection.flags.join(",") || "unspecified"}`
          : "risk_guardian_veto";
    } else if (c.consensusDirection === "no_trade" && !twoSeatConsensus) {
      state = "rejected";
      rejectionReason = "committee_stand_down";
    } else if (
      c.consensusDirection &&
      c.consensusDirection !== "no_trade" &&
      c.consensusDirection !== c.direction
    ) {
      state = "rejected";
      rejectionReason = "direction_mismatch";
    } else {
      state = availableSeats < TOTAL_SEATS ? "degraded" : "reviewing";
    }



    return {
      symbol: c.symbol,
      direction: c.direction,
      state,
      rank: null,
      totalScore: total,
      components,
      expectedNetEdgeBps: edges[i],
      availableSeats,
      unavailableSeats,
      riskVeto: veto,
      riskObjection: objection,
      rejectionReason,

      seats: c.seats,
      verdict: c.verdict,
      consensusConfidence: num(c.consensusConfidence),
      liquidityUsd: num(c.liquidityUsd),
      spreadBps: num(c.spreadBps),
      volatilityPct: num(c.volatilityPct),
      signalId: c.signalId,
      candidateId: c.candidateId ?? null,
      evaluationId: c.evaluationId ?? null,
      evidenceHash: c.evidenceHash ?? null,
    };
  });

  ranked.sort(
    (a, b) =>
      b.totalScore - a.totalScore ||
      a.symbol.localeCompare(b.symbol) ||
      a.direction.localeCompare(b.direction),
  );
  ranked.forEach((r, i) => {
    r.rank = i + 1;
  });

  const eligible = ranked.filter((r) => r.state === "reviewing" || r.state === "degraded");
  const winner = eligible.find((r) => r.totalScore >= threshold) ?? null;

  if (!winner) {
    const reason =
      eligible.length === 0
        ? ranked.every((r) => r.riskVeto)
          ? "risk_guardian_veto_all"
          : "no_candidate_passed_review"
        : "below_selection_threshold";
    for (const r of ranked) {
      if (r.state === "reviewing" || r.state === "degraded") {
        r.state = "no_trade";
        r.rejectionReason = r.rejectionReason ?? reason;
      }
    }
    return { ranked, selected: null, noTradeReason: reason };
  }

  winner.state = "selected";
  winner.rejectionReason = null;
  for (const r of ranked) {
    if (r !== winner && (r.state === "reviewing" || r.state === "degraded")) {
      r.state = "rejected";
      r.rejectionReason = r.rejectionReason ?? "outranked";
    }
  }
  return { ranked, selected: winner, noTradeReason: null };
}

/**
 * Stable cycle key: one selection pass per closed 15-minute candle per book.
 * The database unique constraint on (user_id, cycle_key) turns a replayed or
 * concurrent scheduler tick into a no-op rather than a second selection.
 */
export function cycleKeyFor(candleCloseMs: number, book: "paper" | "live"): string {
  const decisionMs = ORCHESTRATION.decision_interval_min * 60_000;
  const bucket = Math.floor(candleCloseMs / decisionMs) * decisionMs;
  return `${book}:${new Date(bucket).toISOString()}`;
}
