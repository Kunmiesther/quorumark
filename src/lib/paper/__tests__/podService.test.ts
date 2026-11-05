/**
 * Focused tests for the atomic pod/leg service.
 *
 * Uses a hand-rolled fake SupabaseClient that records the sequence of
 * .from().insert() + .rpc() calls and lets each test dictate return
 * values / errors. This is the same pattern already used by
 * accumulator-dca.test.ts and hedge tests in this package.
 */
import { describe, it, expect, vi } from "vitest";
import { authorizeAndOpen, insertAuthorization, bindPodAndReserveLeg, releaseLeg } from "../podService";

type RpcHandler = (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown };

function makeSupabase(opts: {
  authInsertReturn?: { data?: unknown; error?: unknown };
  rpc: RpcHandler;
}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const insertCalls: Array<{ table: string; row: unknown }> = [];
  const client = {
    from: (table: string) => ({
      insert: (row: unknown) => {
        insertCalls.push({ table, row });
        return {
          select: () => ({
            single: () =>
              Promise.resolve(
                opts.authInsertReturn ?? {
                  data: {
                    id: "auth-1",
                    expires_at: new Date(Date.now() + 60_000).toISOString(),
                    correlation_id: "corr-1",
                  },
                  error: null,
                },
              ),
          }),
        };
      },
    }),
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve(opts.rpc(name, args));
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
  return { client, rpcCalls, insertCalls };
}

const baseAuth = {
  userId: "u1",
  connectionId: null,
  exchange: "apex",
  environment: "paper" as const,
  marketType: "paper" as const,
  runId: "soak_test",
  epochId: null,
  scanId: "scan-1",
  signalId: "sig-1",
  rankingSnapshotId: "rank-1",
  onyxDecisionId: "onyx-1",
  symbol: "BTC-USDT",
  direction: "long" as const,
  formation: "precision",
  approvedLeverage: 25,
  approvedMarginMode: "cross" as const,
  approvedNotional: 3000,
  approvedMargin: 120,
  universeVersion: 1,
  rankingVersion: 1,
  envelopeVersion: 1,
  rulesVersion: 1,
  ttlSecs: 300,
};

describe("podService.authorizeAndOpen — happy path", () => {
  it("inserts auth, binds pod+leg, and opens the position in one atomic sequence", async () => {
    const { client, rpcCalls, insertCalls } = makeSupabase({
      rpc: (name) => {
        if (name === "paper_bind_pod_and_reserve_leg") {
          return {
            data: {
              pod_id: "pod-1",
              leg_id: "leg-long-1",
              authorization_id: "auth-1",
              symbol: "BTC-USDT",
              direction: "long",
              purpose: "primary",
            },
            error: null,
          };
        }
        if (name === "paper_open_position") {
          return { data: { position_id: "pos-1", leg_id: "leg-long-1", pod_id: "pod-1" }, error: null };
        }
        return { data: null, error: { code: "unknown" } };
      },
    });

    const res = await authorizeAndOpen(client, {
      authorization: baseAuth,
      purpose: "primary",
      formation: {
        userId: "u1",
        walletId: "wallet-1",
        formationPayload: {
          wallet_key: "pod-1-long",
          entry_price: 60000,
          entry_ts: new Date().toISOString(),
          entry_candle_ts_ms: Date.now(),
          size_qty: 0.05,
          size_notional: 3000,
          margin: 120,
          leverage: 25,
          entry_fee: 0.6,
          strategy: "adaptive_precision",
        },
      },
    });

    expect(res.ok).toBe(true);
    expect(insertCalls[0]?.table).toBe("paper_authorizations");
    // Sequence must be: bind, then open — never open first.
    expect(rpcCalls.map((c) => c.name)).toEqual([
      "paper_bind_pod_and_reserve_leg",
      "paper_open_position",
    ]);
    // Open payload MUST carry the auth/pod/leg linkage.
    const openArgs = rpcCalls[1]?.args as { _payload: Record<string, unknown> };
    expect(openArgs._payload.authorization_id).toBe("auth-1");
    expect(openArgs._payload.pod_id).toBe("pod-1");
    expect(openArgs._payload.leg_id).toBe("leg-long-1");
    expect(openArgs._payload.direction).toBe("long");
  });
});

describe("podService.authorizeAndOpen — rollback safety", () => {
  it("releases the reserved leg when paper_open_position fails", async () => {
    const releaseSpy = vi.fn();
    const { client, rpcCalls } = makeSupabase({
      rpc: (name, args) => {
        if (name === "paper_bind_pod_and_reserve_leg") {
          return {
            data: { pod_id: "pod-2", leg_id: "leg-short-2", authorization_id: "auth-1", symbol: "BTC-USDT", direction: "short", purpose: "hedge" },
            error: null,
          };
        }
        if (name === "paper_open_position") {
          return { data: null, error: { code: "check_violation" } };
        }
        if (name === "paper_release_wallet_leg") {
          releaseSpy(args);
          return { data: true, error: null };
        }
        return { data: null, error: { code: "unknown" } };
      },
    });

    const res = await authorizeAndOpen(client, {
      authorization: { ...baseAuth, direction: "short" },
      purpose: "hedge",
      formation: { userId: "u1", walletId: "wallet-1", formationPayload: { wallet_key: "pod-2-short" } },
    });

    expect(res.ok).toBe(false);
    if (!res.ok && res.error.kind === "open_failed") {
      expect(res.error.released).toBe(true);
    } else {
      throw new Error("expected open_failed with released=true");
    }
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy.mock.calls[0][0]).toMatchObject({ _leg_id: "leg-short-2" });
    // No paper_open_position after release attempt.
    expect(rpcCalls.map((c) => c.name)).toEqual([
      "paper_bind_pod_and_reserve_leg",
      "paper_open_position",
      "paper_release_wallet_leg",
    ]);
  });

  it("surfaces no_free_pod without attempting to open a position", async () => {
    const { client, rpcCalls } = makeSupabase({
      rpc: (name) => {
        if (name === "paper_bind_pod_and_reserve_leg") {
          return { data: { pod_id: null, leg_id: null, reason: "no_free_pod" }, error: null };
        }
        return { data: null, error: { code: "should_not_be_called" } };
      },
    });

    const res = await authorizeAndOpen(client, {
      authorization: baseAuth,
      purpose: "primary",
      formation: { userId: "u1", walletId: "wallet-1", formationPayload: {} },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("no_free_pod");
    expect(rpcCalls.map((c) => c.name)).toEqual(["paper_bind_pod_and_reserve_leg"]);
  });

  it("stops before bind if authorization insert fails", async () => {
    const { client, rpcCalls } = makeSupabase({
      authInsertReturn: { data: null, error: { code: "23505" } },
      rpc: () => ({ data: null, error: { code: "should_not_be_called" } }),
    });

    const res = await authorizeAndOpen(client, {
      authorization: baseAuth,
      purpose: "primary",
      formation: { userId: "u1", walletId: "wallet-1", formationPayload: {} },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("auth_insert_failed");
    expect(rpcCalls).toEqual([]);
  });
});

describe("podService — direction independence", () => {
  it("primary long and hedge short bind to different legs on the same pod symbol", async () => {
    const returns: Record<string, unknown> = {
      long: { pod_id: "pod-3", leg_id: "leg-3-long", authorization_id: "auth-1", symbol: "ETH-USDT", direction: "long", purpose: "primary" },
      short: { pod_id: "pod-3", leg_id: "leg-3-short", authorization_id: "auth-1", symbol: "ETH-USDT", direction: "short", purpose: "hedge" },
    };
    let call = 0;
    const { client } = makeSupabase({
      rpc: () => {
        call += 1;
        const dir = call === 1 ? "long" : "short";
        return { data: returns[dir], error: null };
      },
    });

    const long = await bindPodAndReserveLeg(client, { userId: "u1", authorizationId: "auth-1", purpose: "primary" });
    const short = await bindPodAndReserveLeg(client, { userId: "u1", authorizationId: "auth-1", purpose: "hedge" });

    expect(long.ok && short.ok).toBe(true);
    if (long.ok && short.ok) {
      expect(long.value.legId).not.toBe(short.value.legId);
      expect(long.value.direction).toBe("long");
      expect(short.value.direction).toBe("short");
      expect(long.value.podId).toBe(short.value.podId);
    }
  });
});

describe("podService — release helper", () => {
  it("release resolves true on successful RPC", async () => {
    const { client } = makeSupabase({ rpc: () => ({ data: true, error: null }) });
    const released = await releaseLeg(client, { userId: "u1", legId: "leg-x", reason: "unit" });
    expect(released).toBe(true);
  });
});

// Guard so the test file always compiles even if insertAuthorization becomes unused in isolation.
void insertAuthorization;
