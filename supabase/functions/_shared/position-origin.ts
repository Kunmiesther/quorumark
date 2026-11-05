/**
 * Position origin classification — PURE, no I/O.
 *
 * A venue position is only "venue_external" when NOTHING in Turtle Bot's own
 * records can account for it. Before this module the reconciler asked one
 * question (is there a recent `orders` row?), so every position opened through
 * the broker/signer path — which writes `order_audit` and `strategy_decisions`,
 * not `orders` — was mislabelled as an owner's manual venue trade and lost its
 * originating strategy and trace.
 *
 * Evidence is ranked: a strategy decision is the strongest link (it carries the
 * strategy name and trace id), then a broker audit row, then a legacy orders
 * row. The first match wins and the resulting attribution is what the position
 * row stores.
 */

export type OriginKind = "turtlebot" | "venue_external";

export interface DecisionEvidence {
  decision_id?: string | null;
  strategy?: string | null;
  trace_id?: string | null;
  direction?: string | null;
  execution_state?: string | null;
}

export interface AuditEvidence {
  idempotency_key?: string | null;
  exchange_order_id?: string | null;
  side?: string | null;
  phase?: string | null;
}

export interface OrderEvidence {
  id?: string | null;
}

export interface OriginAttribution {
  origin: OriginKind;
  /** Originating bot/strategy, e.g. "sweep". Null for external positions. */
  strategy: string | null;
  trace_id: string | null;
  decision_id: string | null;
  idempotency_key: string | null;
  exchange_order_id: string | null;
  /** Which record proved the link. */
  evidence: "strategy_decision" | "order_audit" | "orders" | "none";
}

const EXTERNAL: OriginAttribution = {
  origin: "venue_external",
  strategy: null,
  trace_id: null,
  decision_id: null,
  idempotency_key: null,
  exchange_order_id: null,
  evidence: "none",
};

/** Map a venue side to the decision direction vocabulary. */
export function sideToDirection(side: string | null | undefined): "long" | "short" | null {
  const s = String(side ?? "").toLowerCase();
  if (s === "long" || s === "buy") return "long";
  if (s === "short" || s === "sell") return "short";
  return null;
}

/** Missing/inaccessible ledgers are not evidence of a manual trade. */
export function requireOriginReads(input: {
  decisions: { data: DecisionEvidence[] | null; error: unknown };
  audits: { data: AuditEvidence[] | null; error: unknown };
  orders: { data: OrderEvidence[] | null; error: unknown };
}) {
  for (const result of Object.values(input)) {
    if (result.error || !Array.isArray(result.data)) {
      throw new Error("POSITION_ORIGIN_READ_FAILED");
    }
  }
  return {
    decisions: input.decisions.data!, audits: input.audits.data!, orders: input.orders.data!,
  };
}

export function classifyOrigin(input: {
  decisions?: DecisionEvidence[] | null;
  audits?: AuditEvidence[] | null;
  orders?: OrderEvidence[] | null;
  side?: string | null;
}): OriginAttribution {
  const direction = sideToDirection(input.side);

  const decisions = (input.decisions ?? []).filter((d) => {
    if (!d) return false;
    // A WAIT decision never opened anything. Direction must match when known.
    const dir = String(d.direction ?? "").toLowerCase();
    if (dir === "wait" || dir === "") return false;
    return direction === null || dir === direction;
  });
  const decision = decisions[0];
  if (decision) {
    return {
      origin: "turtlebot",
      strategy: decision.strategy ? String(decision.strategy).toLowerCase() : null,
      trace_id: decision.trace_id ? String(decision.trace_id) : null,
      decision_id: decision.decision_id ? String(decision.decision_id) : null,
      idempotency_key: null,
      exchange_order_id: null,
      evidence: "strategy_decision",
    };
  }

  const audit = (input.audits ?? []).find((a) => {
    if (!a) return false;
    const s = sideToDirection(a.side);
    return s === null || direction === null || s === direction;
  });
  if (audit) {
    return {
      origin: "turtlebot",
      strategy: null,
      trace_id: null,
      decision_id: null,
      idempotency_key: audit.idempotency_key ? String(audit.idempotency_key) : null,
      exchange_order_id: audit.exchange_order_id ? String(audit.exchange_order_id) : null,
      evidence: "order_audit",
    };
  }

  if ((input.orders ?? []).length > 0) {
    return { ...EXTERNAL, origin: "turtlebot", evidence: "orders" };
  }

  return { ...EXTERNAL };
}
