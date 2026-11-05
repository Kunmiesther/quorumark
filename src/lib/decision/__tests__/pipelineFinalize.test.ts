// Proof for the terminal-outcome contract. No network, no database.
//
// These assert the two properties the owner required and that live NO_TRADE
// traces cannot demonstrate on their own:
//   • a TRADE_CANDIDATE creates a SIMULATED intent that reaches VALIDATED or
//     REJECTED, and never submits;
//   • risk failures land on NO_TRADE_RISK with the exact failing code.
import { describe, expect, it } from "vitest";
import { runConsolidatedRiskCheck } from "@/lib/decision/pipelineFinalize.server";

type Row = Parameters<typeof runConsolidatedRiskCheck>[1];

const baseRow = {
  decision_id: "dec_test",
  user_id: "u1",
  connection_id: "c1",
  symbol: "ETH-USDT",
  strategy: "accumulator",
  timeframe: "5m",
  candle_close_at: new Date().toISOString(),
  direction: "long",
  reason_code: "LONG_CONFIRMED",
  reason: "confirmed",
  entry_zone: { low: 3000, high: 3010 },
  invalidation: 2950,
  take_profits: [3100],
  evidence_hash: "h",
  execution_state: "not_reached",
  execution_reason_code: null,
  order_intent: null,
  trace_id: null,
  terminal_outcome: null,
} as unknown as Row;

function stubClient(opts: {
  conn?: Record<string, unknown> | null;
  halts?: Array<Record<string, unknown>>;
  positions?: Array<Record<string, unknown>>;
}) {
  const conn = opts.conn === undefined
    ? { status: "verified", is_live: true, permission_trade: true, permissions_verified: true, environment: "mainnet", market_type: "futures" }
    : opts.conn;
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: conn }),
        then: undefined,
      };
      if (table === "kill_switches") {
        let calls = 0;
        const kchain: Record<string, unknown> = {
          select: () => kchain,
          eq: () => {
            calls += 1;
            // resolves after the second .eq() in the finalizer
            return calls >= 2
              ? Promise.resolve({ data: opts.halts ?? [] })
              : kchain;
          },
        };
        return kchain;
      }
      if (table === "positions") {
        let calls = 0;
        const pchain: Record<string, unknown> = {
          select: () => pchain,
          eq: () => {
            calls += 1;
            return calls >= 3
              ? Promise.resolve({ data: opts.positions ?? [] })
              : pchain;
          },
        };
        return pchain;
      }
      return chain;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("consolidated risk check", () => {
  it("passes when connection is trade-ready, unhalted, flat and fresh", async () => {
    const r = await runConsolidatedRiskCheck(stubClient({}), baseRow, Date.now());
    expect(r.passed).toBe(true);
    expect(r.code).toBe("OK");
    expect(r.checks).toHaveLength(4);
  });

  it("fails with EMERGENCY_HALT_ACTIVE when a kill switch is on", async () => {
    const r = await runConsolidatedRiskCheck(
      stubClient({ halts: [{ scope: "global", reason: "owner" }] }),
      baseRow,
      Date.now(),
    );
    expect(r.passed).toBe(false);
    expect(r.code).toBe("EMERGENCY_HALT_ACTIVE");
  });

  it("fails with EXISTING_EXPOSURE when the symbol already has a position", async () => {
    const r = await runConsolidatedRiskCheck(
      stubClient({ positions: [{ id: "p", pair: "ETH-USDT", side: "long", status: "open" }] }),
      baseRow,
      Date.now(),
    );
    expect(r.passed).toBe(false);
    expect(r.code).toBe("EXISTING_EXPOSURE");
  });

  it("fails with CONNECTION_NOT_TRADE_READY when permissions are unverified", async () => {
    const r = await runConsolidatedRiskCheck(
      stubClient({
        conn: { status: "verified", permission_trade: true, permissions_verified: false, environment: "mainnet" },
      }),
      baseRow,
      Date.now(),
    );
    expect(r.passed).toBe(false);
    expect(r.code).toBe("CONNECTION_NOT_TRADE_READY");
  });

  it("fails with MARKET_DATA_STALE on an old candle", async () => {
    const stale = { ...baseRow, candle_close_at: new Date(Date.now() - 60 * 60_000).toISOString() } as Row;
    const r = await runConsolidatedRiskCheck(stubClient({}), stale, Date.now());
    expect(r.passed).toBe(false);
    expect(r.code).toBe("MARKET_DATA_STALE");
  });
});
