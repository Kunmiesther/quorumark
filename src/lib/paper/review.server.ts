// SERVER-ONLY review / learning agent for closed PAPER trades.
//
// Contract (owner directive, agentic OS):
//   • After closure, compute the realized outcome and attribute it to the
//     strategy, regime, Scout ranking, EACH model opinion, the ONYX decision
//     and the management actions taken on the position.
//   • Learning is BOUNDED. This module may write review rows and PROPOSE rule
//     changes. It may not rewrite prompts, strategies, leverage, risk
//     thresholds or production code, and every proposal stays `pending` until
//     the owner explicitly approves it.
//   • Linkage is never fabricated. A trade closed before the orchestration
//     contract existed is marked `unattributed = true` rather than guessed at.

import type { SupabaseClient } from "@supabase/supabase-js";

export const REVIEWS_TABLE = "paper_trade_reviews";
export const PROPOSALS_TABLE = "agentic_rule_proposals";

/** Bound on trades reviewed per sweep. */
export const MAX_REVIEWS_PER_SWEEP = 40;
/** Minimum closed sample before the learning agent may propose anything. */
export const MIN_PROPOSAL_SAMPLE = 25;

export type TradeOutcome = "win" | "loss" | "scratch";

export interface ModelAttribution {
  role: string;
  provider: string;
  model: string;
  status: string;
  direction: string | null;
  confidence: number | null;
  /** null when the seat did not answer — absence is not a wrong call. */
  correct: boolean | null;
}

export function classifyOutcome(pnlNet: number): TradeOutcome {
  if (pnlNet > 0) return "win";
  if (pnlNet < 0) return "loss";
  return "scratch";
}

/**
 * A seat is "correct" when the side it advocated matches the side that made
 * money. A `wait` opinion is correct exactly when the trade lost.
 */
export function scoreOpinion(
  direction: string | null,
  tradeDirection: string,
  outcome: TradeOutcome,
): boolean | null {
  if (direction == null) return null;
  if (outcome === "scratch") return null;
  if (direction === "wait") return outcome === "loss";
  return direction === tradeDirection ? outcome === "win" : outcome === "loss";
}

export function rMultiple(
  pnlNet: number,
  entry: number,
  stop: number | null,
  qty: number,
): number | null {
  if (stop == null || !Number.isFinite(stop) || !Number.isFinite(entry) || !Number.isFinite(qty)) return null;
  const risk = Math.abs(entry - stop) * Math.abs(qty);
  if (!(risk > 0)) return null;
  return Number((pnlNet / risk).toFixed(4));
}

export interface ReviewSweepSummary {
  scanned: number;
  reviewed: number;
  unattributed: number;
  proposals: number;
  errors: number;
}

/**
 * Review every recently closed paper trade for one user that does not have a
 * review row yet. Idempotent per (user, trade).
 */
export async function sweepTradeReviews(
  reader: SupabaseClient,
  userId: string,
  lookbackHours = 48,
): Promise<ReviewSweepSummary> {
  const summary: ReviewSweepSummary = { scanned: 0, reviewed: 0, unattributed: 0, proposals: 0, errors: 0 };

  try {
    const { ledgerClient } = await import("@/lib/ai/committee/ledger.server");
    const ledger = await ledgerClient();
    const since = new Date(Date.now() - lookbackHours * 3_600_000).toISOString();

    const { data: trades } = await reader
      .from("paper_trades")
      .select(
        "id, symbol, direction, entry_price, exit_price, exit_reason, size_qty, margin, " +
          "pnl_net, pnl_gross, fees, hold_seconds, closed_at, position_id, orchestration_trace_id",
      )
      .eq("user_id", userId)
      .gte("closed_at", since)
      .order("closed_at", { ascending: false })
      .limit(MAX_REVIEWS_PER_SWEEP);
    if (!trades?.length) return summary;

    const tradeIds = trades.map((t) => String((t as unknown as Record<string, unknown>).id));
    const { data: existing } = await ledger
      .from(REVIEWS_TABLE)
      .select("paper_trade_id")
      .eq("user_id", userId)
      .in("paper_trade_id", tradeIds);
    const done = new Set((existing ?? []).map((r) => String((r as unknown as Record<string, unknown>).paper_trade_id)));

    for (const raw of trades) {
      const t = raw as unknown as Record<string, unknown>;
      const tradeId = String(t.id);
      summary.scanned += 1;
      if (done.has(tradeId)) continue;

      const pnlNet = Number(t.pnl_net ?? 0);
      const outcome = classifyOutcome(pnlNet);
      const direction = String(t.direction);
      const traceId = (t.orchestration_trace_id as string | null) ?? null;
      const positionId = (t.position_id as string | null) ?? null;

      // Position context — strategy, regime, stop geometry.
      let strategy: string | null = null;
      let regime: string | null = null;
      let stop: number | null = null;
      if (positionId) {
        const { data: pos } = await reader
          .from("paper_positions")
          .select("strategy, regime_at_entry, stop_level")
          .eq("id", positionId)
          .maybeSingle();
        const p = (pos ?? null) as Record<string, unknown> | null;
        strategy = (p?.strategy as string | null) ?? null;
        regime = (p?.regime_at_entry as string | null) ?? null;
        stop = p?.stop_level == null ? null : Number(p.stop_level);
      }

      // Orchestration context — participation, ONYX, model opinions.
      let participation: string | null = null;
      let onyxDecision: string | null = null;
      let attribution: ModelAttribution[] = [];
      if (traceId) {
        const { data: orch } = await ledger
          .from("paper_ai_orchestrations")
          .select("participation, onyx_decision")
          .eq("trace_id", traceId)
          .maybeSingle();
        const o = (orch ?? null) as Record<string, unknown> | null;
        participation = (o?.participation as string | null) ?? null;
        onyxDecision = (o?.onyx_decision as string | null) ?? null;

        const { data: opinions } = await ledger
          .from("paper_ai_opinions")
          .select("role, provider, model, status, direction, confidence")
          .eq("trace_id", traceId);
        attribution = (opinions ?? []).map((rawOp) => {
          const op = rawOp as unknown as Record<string, unknown>;
          const dir = (op.direction as string | null) ?? null;
          return {
            role: String(op.role),
            provider: String(op.provider),
            model: String(op.model),
            status: String(op.status),
            direction: dir,
            confidence: op.confidence == null ? null : Number(op.confidence),
            correct: scoreOpinion(dir, direction, outcome),
          };
        });
      }

      // Management actions appended to this position's timeline.
      let managementActions = 0;
      if (positionId) {
        const { count } = await ledger
          .from("paper_position_events")
          .select("id", { count: "exact", head: true })
          .eq("paper_position_id", positionId);
        managementActions = count ?? 0;
      }

      const unattributed = traceId == null;
      if (unattributed) summary.unattributed += 1;

      const insert = await ledger.from(REVIEWS_TABLE).insert({
        user_id: userId,
        paper_trade_id: tradeId,
        trace_id: traceId,
        symbol: String(t.symbol),
        direction,
        strategy,
        regime,
        scout_rank: null,
        pnl_net: pnlNet,
        pnl_gross: Number(t.pnl_gross ?? 0),
        fees: Number(t.fees ?? 0),
        r_multiple: rMultiple(pnlNet, Number(t.entry_price ?? 0), stop, Number(t.size_qty ?? 0)),
        hold_seconds: t.hold_seconds == null ? null : Math.trunc(Number(t.hold_seconds)),
        outcome,
        exit_reason: (t.exit_reason as string | null) ?? null,
        participation,
        onyx_decision: onyxDecision,
        onyx_correct: onyxDecision == null ? null : (onyxDecision === "enter" ? outcome === "win" : outcome !== "win"),
        model_attribution: attribution,
        management_actions: managementActions,
        unattributed,
        closed_at: (t.closed_at as string | null) ?? null,
      });
      if (insert.error) { summary.errors += 1; continue; }
      summary.reviewed += 1;
    }

    summary.proposals = await proposeBoundedRuleChanges(ledger, userId);
    return summary;
  } catch {
    summary.errors += 1;
    return summary;
  }
}

/**
 * Bounded learning. Emits PENDING proposals only — nothing here changes a
 * prompt, a strategy, a leverage bound, a risk threshold or any code path.
 * Owner approval is required for a proposal to mean anything.
 */
export async function proposeBoundedRuleChanges(
  ledger: SupabaseClient,
  userId: string,
): Promise<number> {
  const { data: reviews } = await ledger
    .from(REVIEWS_TABLE)
    .select("strategy, outcome, pnl_net, participation")
    .eq("user_id", userId)
    .order("closed_at", { ascending: false })
    .limit(400);
  const rows = (reviews ?? []) as unknown as Array<Record<string, unknown>>;
  if (rows.length < MIN_PROPOSAL_SAMPLE) return 0;

  const byStrategy = new Map<string, { n: number; wins: number; pnl: number }>();
  for (const r of rows) {
    const key = (r.strategy as string | null) ?? "unknown";
    const agg = byStrategy.get(key) ?? { n: 0, wins: 0, pnl: 0 };
    agg.n += 1;
    if (String(r.outcome) === "win") agg.wins += 1;
    agg.pnl += Number(r.pnl_net ?? 0);
    byStrategy.set(key, agg);
  }

  let created = 0;
  for (const [strategy, agg] of byStrategy) {
    if (agg.n < MIN_PROPOSAL_SAMPLE || agg.pnl >= 0) continue;
    const winRate = agg.n > 0 ? agg.wins / agg.n : 0;
    const title = `Review ${strategy}: negative paper expectancy over ${agg.n} trades`;
    const insert = await ledger.from(PROPOSALS_TABLE).insert({
      user_id: userId,
      scope: `strategy:${strategy}`,
      title,
      rationale:
        `Closed paper sample of ${agg.n} trades on ${strategy} shows net ${agg.pnl.toFixed(2)} ` +
        `with a ${(winRate * 100).toFixed(1)}% win rate. Proposing owner review; no change applied.`,
      evidence: { sample: agg.n, wins: agg.wins, net_pnl: agg.pnl, win_rate: winRate },
      proposed_change: { action: "owner_review", target: strategy, applied: false },
      sample_size: agg.n,
      status: "pending",
    });
    // A duplicate open proposal is expected and ignored (partial unique index).
    if (!insert.error) created += 1;
  }
  return created;
}
