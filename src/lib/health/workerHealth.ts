/**
 * Authoritative worker runtime health.
 *
 * `public.worker_heartbeats` is the SOLE source of truth for Railway worker
 * runtime health, keyed by (worker_id, environment). The legacy singleton
 * `public.bot_heartbeat` row is retained as audit history only and MUST NOT
 * participate in any readiness, health or UI decision.
 *
 * Rules:
 *  - Selection is deterministic: newest `last_seen_at` within the requested
 *    environment+mode, tie-broken by `worker_id` ascending.
 *  - Freshness is measured against an explicit server-derived timestamp.
 *  - A stale historical row is never "current"; a missing row is never healthy.
 */

export type WorkerRuntimeState = "healthy" | "degraded" | "stale" | "missing";

export interface WorkerHeartbeatRow {
  worker_id: string;
  environment: string;
  mode: string;
  status: string;
  last_seen_at: string;
  health: unknown;
  version?: string | null;
}

export interface AuthoritativeSelector {
  environment: string;
  mode: string;
}

/** The production live worker is the only heartbeat that can satisfy live readiness. */
export const PRODUCTION_LIVE_SELECTOR: AuthoritativeSelector = {
  environment: "production",
  mode: "live",
};

/** A heartbeat older than this is stale, regardless of the status it reported. */
export const HEARTBEAT_FRESHNESS_MS = 120_000;

export interface WorkerHealth {
  state: WorkerRuntimeState;
  /** True only for `healthy`: fresh, status healthy and credentials loaded. */
  ready: boolean;
  workerId: string | null;
  environment: string | null;
  mode: string | null;
  reportedStatus: string | null;
  version: string | null;
  lastSeenAt: string | null;
  ageMs: number | null;
  /** `null` when the worker did not report a credentials flag. */
  credentialsOk: boolean | null;
  /** Raw reported health payload (unknown shape — read with `readHealthString`). */
  healthPayload: unknown;
  reason: string;
}

function parseTimestamp(iso: string): number {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/** Reads `health.credentials_ok` without unsafe casts. */
export function readCredentialsOk(health: unknown): boolean | null {
  if (health === null || typeof health !== "object") return null;
  const value = (health as Record<string, unknown>)["credentials_ok"];
  return typeof value === "boolean" ? value : null;
}

/** Reads a string-ish field from the worker-reported health payload. */
export function readHealthString(health: unknown, key: string): string | null {
  if (health === null || typeof health !== "object") return null;
  const value = (health as Record<string, unknown>)[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

export function selectAuthoritativeHeartbeat(
  rows: readonly WorkerHeartbeatRow[],
  selector: AuthoritativeSelector = PRODUCTION_LIVE_SELECTOR,
): WorkerHeartbeatRow | null {
  const matches = rows.filter(
    (row) =>
      row.environment === selector.environment &&
      row.mode.toLowerCase() === selector.mode.toLowerCase(),
  );
  if (matches.length === 0) return null;
  const sorted = [...matches].sort((a, b) => {
    const at = parseTimestamp(a.last_seen_at);
    const bt = parseTimestamp(b.last_seen_at);
    const av = Number.isNaN(at) ? -Infinity : at;
    const bv = Number.isNaN(bt) ? -Infinity : bt;
    if (av !== bv) return bv - av;
    return a.worker_id.localeCompare(b.worker_id);
  });
  return sorted[0] ?? null;
}

export function evaluateWorkerHealth(
  row: WorkerHeartbeatRow | null,
  nowMs: number,
  freshnessMs: number = HEARTBEAT_FRESHNESS_MS,
): WorkerHealth {
  if (!row) {
    return {
      state: "missing",
      ready: false,
      workerId: null,
      environment: null,
      mode: null,
      reportedStatus: null,
      version: null,
      lastSeenAt: null,
      ageMs: null,
      credentialsOk: null,
      healthPayload: null,
      reason: "No authoritative worker heartbeat found",
    };
  }

  const seen = parseTimestamp(row.last_seen_at);
  const ageMs = Number.isNaN(seen) ? null : Math.max(0, nowMs - seen);
  const credentialsOk = readCredentialsOk(row.health);
  const base = {
    workerId: row.worker_id,
    environment: row.environment,
    mode: row.mode,
    reportedStatus: row.status,
    version: row.version ?? null,
    lastSeenAt: row.last_seen_at,
    ageMs,
    credentialsOk,
    healthPayload: row.health,
  };

  if (ageMs === null || ageMs >= freshnessMs) {
    return {
      ...base,
      state: "stale",
      ready: false,
      reason:
        ageMs === null
          ? "Heartbeat timestamp is unreadable"
          : `Heartbeat is ${Math.round(ageMs / 1000)}s old`,
    };
  }
  if (row.status !== "healthy") {
    return {
      ...base,
      state: "degraded",
      ready: false,
      reason: `Worker reported status "${row.status}"`,
    };
  }
  if (credentialsOk !== true) {
    return {
      ...base,
      state: "degraded",
      ready: false,
      reason:
        credentialsOk === false
          ? "Worker credentials are not loaded"
          : "Worker did not report credential status",
    };
  }
  return { ...base, state: "healthy", ready: true, reason: "Worker healthy" };
}

/** Convenience: deterministic selection + evaluation in one step. */
export function deriveWorkerHealth(
  rows: readonly WorkerHeartbeatRow[],
  nowMs: number,
  selector: AuthoritativeSelector = PRODUCTION_LIVE_SELECTOR,
  freshnessMs: number = HEARTBEAT_FRESHNESS_MS,
): WorkerHealth {
  return evaluateWorkerHealth(selectAuthoritativeHeartbeat(rows, selector), nowMs, freshnessMs);
}

export function workerStateLabel(state: WorkerRuntimeState): string {
  switch (state) {
    case "healthy":
      return "Healthy";
    case "degraded":
      return "Degraded";
    case "stale":
      return "Stale";
    case "missing":
    default:
      return "Missing";
  }
}

export function formatHeartbeatAge(ageMs: number | null): string {
  if (ageMs === null) return "—";
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const WORKER_HEARTBEAT_COLUMNS =
  "worker_id, environment, mode, status, last_seen_at, health, version";
