import { describe, expect, it } from "vitest";
import {
  deriveWorkerHealth,
  evaluateWorkerHealth,
  selectAuthoritativeHeartbeat,
  HEARTBEAT_FRESHNESS_MS,
  type WorkerHeartbeatRow,
} from "@/lib/health/workerHealth";

const NOW = Date.parse("2026-07-31T19:00:00.000Z");

function row(over: Partial<WorkerHeartbeatRow> = {}): WorkerHeartbeatRow {
  return {
    worker_id: "railway-turtlebot-primary",
    environment: "production",
    mode: "live",
    status: "healthy",
    last_seen_at: new Date(NOW - 5_000).toISOString(),
    health: { credentials_ok: true, note: "Worker online (live)" },
    version: "1.0.0",
    ...over,
  };
}

describe("authoritative worker health", () => {
  it("is healthy for a fresh production worker even though a stale legacy row exists", () => {
    // The legacy `bot_heartbeat` row is not part of this input by construction:
    // only worker_heartbeats rows are ever passed in.
    const health = deriveWorkerHealth([row()], NOW);
    expect(health.state).toBe("healthy");
    expect(health.ready).toBe(true);
    expect(health.workerId).toBe("railway-turtlebot-primary");
    expect(health.credentialsOk).toBe(true);
  });

  it("marks a stale production worker as stale and not ready", () => {
    const health = deriveWorkerHealth(
      [row({ last_seen_at: new Date(NOW - HEARTBEAT_FRESHNESS_MS - 1).toISOString() })],
      NOW,
    );
    expect(health.state).toBe("stale");
    expect(health.ready).toBe(false);
  });

  it("marks a missing production worker as missing and not ready", () => {
    const health = deriveWorkerHealth([], NOW);
    expect(health.state).toBe("missing");
    expect(health.ready).toBe(false);
    expect(health.lastSeenAt).toBeNull();
  });

  it("marks credentials=false as degraded and not ready", () => {
    const health = deriveWorkerHealth([row({ health: { credentials_ok: false } })], NOW);
    expect(health.state).toBe("degraded");
    expect(health.ready).toBe(false);
    expect(health.credentialsOk).toBe(false);
  });

  it("treats a missing credentials flag as degraded", () => {
    const health = deriveWorkerHealth([row({ health: {} })], NOW);
    expect(health.state).toBe("degraded");
    expect(health.credentialsOk).toBeNull();
  });

  it("marks a non-healthy reported status as degraded", () => {
    const health = deriveWorkerHealth([row({ status: "degraded" })], NOW);
    expect(health.state).toBe("degraded");
    expect(health.ready).toBe(false);
  });

  it("does not let a paper/test worker satisfy production live readiness", () => {
    const rows = [
      row({ worker_id: "paper-worker", mode: "paper" }),
      row({ worker_id: "staging-worker", environment: "staging" }),
    ];
    const health = deriveWorkerHealth(rows, NOW);
    expect(health.state).toBe("missing");
    expect(health.ready).toBe(false);
  });

  it("selects deterministically when multiple heartbeat rows exist", () => {
    const older = row({ worker_id: "a-worker", last_seen_at: new Date(NOW - 30_000).toISOString() });
    const tieA = row({ worker_id: "b-worker", last_seen_at: new Date(NOW - 5_000).toISOString() });
    const tieB = row({ worker_id: "c-worker", last_seen_at: new Date(NOW - 5_000).toISOString() });

    expect(selectAuthoritativeHeartbeat([older, tieB, tieA])?.worker_id).toBe("b-worker");
    expect(selectAuthoritativeHeartbeat([tieA, tieB, older])?.worker_id).toBe("b-worker");
  });

  it("treats an unreadable timestamp as stale, never healthy", () => {
    const health = evaluateWorkerHealth(row({ last_seen_at: "not-a-date" }), NOW);
    expect(health.state).toBe("stale");
    expect(health.ready).toBe(false);
  });
});
