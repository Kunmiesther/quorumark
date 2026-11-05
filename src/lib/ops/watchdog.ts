/**
 * Watchdog: pure health-state evaluator.
 *
 * States (worst wins across a fleet):
 *   HEALTHY  — every check passes.
 *   DEGRADED — non-critical anomaly (elevated latency, small backlog).
 *   STALE    — one or more required frames past freshness budget.
 *   HALTED   — global-integrity failure; suspend the affected scope.
 *
 * Uptime alone is NEVER sufficient for HEALTHY.
 */

export type HealthState = "HEALTHY" | "DEGRADED" | "STALE" | "HALTED";

export interface ComponentInput {
  component: string;
  last_success_ms: number | null;
  now_ms: number;
  /** Max time since last_success before component is STALE. */
  freshness_budget_ms: number;
  /** Optional backlog; triggers DEGRADED beyond `backlog_warn`. */
  backlog?: number;
  backlog_warn?: number;
  backlog_halt?: number;
  /** Recent latency samples (ms). */
  latency_samples_ms?: number[];
  /** SLO ceiling for p95 latency (ms). */
  p95_budget_ms?: number;
  /** Explicit hard-halt signal from an upstream check (kill switch, DB down). */
  halt?: boolean;
  halt_reason?: string;
}

export interface ComponentHealth {
  component: string;
  state: HealthState;
  reasons: string[];
  freshness_ms: number | null;
  backlog: number;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  last_success_at: number | null;
}

const STATE_RANK: Record<HealthState, number> = {
  HEALTHY: 0,
  DEGRADED: 1,
  STALE: 2,
  HALTED: 3,
};

export function worseState(a: HealthState, b: HealthState): HealthState {
  return STATE_RANK[a] >= STATE_RANK[b] ? a : b;
}

export function percentile(samples: number[], p: number): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function evaluateComponent(input: ComponentInput): ComponentHealth {
  const reasons: string[] = [];
  let state: HealthState = "HEALTHY";

  if (input.halt) {
    state = "HALTED";
    reasons.push(input.halt_reason ?? "HALT_SIGNAL");
  }

  const freshness_ms =
    input.last_success_ms != null ? input.now_ms - input.last_success_ms : null;

  if (freshness_ms == null) {
    state = worseState(state, "STALE");
    reasons.push("NO_SUCCESS_YET");
  } else if (freshness_ms > input.freshness_budget_ms) {
    state = worseState(state, "STALE");
    reasons.push(
      `STALE:${freshness_ms}ms>${input.freshness_budget_ms}ms`,
    );
  }

  const backlog = input.backlog ?? 0;
  if (input.backlog_halt != null && backlog >= input.backlog_halt) {
    state = worseState(state, "HALTED");
    reasons.push(`BACKLOG_HALT:${backlog}`);
  } else if (input.backlog_warn != null && backlog >= input.backlog_warn) {
    state = worseState(state, "DEGRADED");
    reasons.push(`BACKLOG_WARN:${backlog}`);
  }

  const p50 = percentile(input.latency_samples_ms ?? [], 50);
  const p95 = percentile(input.latency_samples_ms ?? [], 95);

  if (input.p95_budget_ms != null && p95 != null && p95 > input.p95_budget_ms) {
    state = worseState(state, "DEGRADED");
    reasons.push(`P95_BUDGET:${p95}ms>${input.p95_budget_ms}ms`);
  }

  return {
    component: input.component,
    state,
    reasons,
    freshness_ms,
    backlog,
    p50_latency_ms: p50,
    p95_latency_ms: p95,
    last_success_at: input.last_success_ms,
  };
}

/** Roll up N component healths into a single fleet state. */
export function rollupFleet(components: ComponentHealth[]): HealthState {
  return components.reduce<HealthState>(
    (acc, c) => worseState(acc, c.state),
    "HEALTHY",
  );
}
