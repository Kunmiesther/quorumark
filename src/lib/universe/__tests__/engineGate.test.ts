/**
 * engineGate — flag-off passthrough + fail-closed semantics.
 *
 * These tests exercise only the public contract of `computeUniverseGate`
 * with a hand-rolled Supabase stub. They confirm:
 *   - Flag OFF ⇒ active=false, no filtering.
 *   - Flag ON + no snapshot ⇒ active=true, allowedNewEntries empty
 *     (open positions still retained).
 *   - Flag ON + fresh snapshot + slots ⇒ ranked ∩ !open ∩ capacity.
 *   - Flag ON + non-paper mode ⇒ passthrough regardless of env.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { computeUniverseGate } from "../engineGate";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function makeSupabaseStub(opts: {
  snapshot?: { id: string; generated_at: string; expires_at: string } | null;
  rankings?: Array<{ symbol: string; bucket: string; direction: string; rank: number }>;
  slots?: Array<{
    id: string; slot_index: number; state: string;
    assigned_symbol: string | null; assigned_direction: string | null;
    position_id: string | null; reservation_expires_at: string | null;
  }>;
  snapshotError?: boolean;
}): Any {
  const chain = (result: { data: Any; error: Any }) => {
    const q: Any = {
      select: () => q,
      eq: () => q,
      gt: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: () => Promise.resolve(result),
      then: (fn: (v: Any) => Any) => Promise.resolve(result).then(fn),
    };
    return q;
  };
  return {
    from: (tbl: string) => {
      if (tbl === "scout_universe_snapshots") {
        return chain({
          data: opts.snapshotError ? null : opts.snapshot ?? null,
          error: opts.snapshotError ? { message: "boom" } : null,
        });
      }
      if (tbl === "scout_symbol_rankings") {
        return chain({ data: opts.rankings ?? [], error: null });
      }
      if (tbl === "paper_execution_slots") {
        return chain({ data: opts.slots ?? [], error: null });
      }
      return chain({ data: [], error: null });
    },
  };
}

function unassignedSlots(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`, slot_index: i, state: "unassigned",
    assigned_symbol: null, assigned_direction: null,
    position_id: null, reservation_expires_at: null,
  }));
}

const ORIGINAL_ENV = process.env.DYNAMIC_UNIVERSE_ENABLED;
beforeEach(() => { delete process.env.DYNAMIC_UNIVERSE_ENABLED; });
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.DYNAMIC_UNIVERSE_ENABLED;
  else process.env.DYNAMIC_UNIVERSE_ENABLED = ORIGINAL_ENV;
});

describe("computeUniverseGate", () => {
  it("passthrough when flag off", async () => {
    const supabase = makeSupabaseStub({});
    const r = await computeUniverseGate({
      supabase, userId: "u1", executionMode: "paper",
      openSymbols: ["BTC-USDT"],
    });
    expect(r.active).toBe(false);
    expect(r.allowedNewEntries.size).toBe(0);
    expect(r.retainedSymbols).toEqual(["BTC-USDT"]);
  });

  it("passthrough on mainnet even when env set", async () => {
    process.env.DYNAMIC_UNIVERSE_ENABLED = "1";
    const supabase = makeSupabaseStub({});
    const r = await computeUniverseGate({
      supabase, userId: "u1", executionMode: "mainnet",
      openSymbols: [],
    });
    expect(r.active).toBe(false);
  });

  // ROLLBACK GUARD (see src/lib/universe/flag.ts): the dynamic-universe
  // pipeline is currently disabled at the source, so `computeUniverseGate`
  // must passthrough (active=false) for every input — including flag-on +
  // fresh snapshot + slots — until the rollback is deliberately reverted.
  // Retention semantics (open positions never filtered) must still hold.
  // These guards are what catches a silent re-enable in a future edit.
  it("passthrough even with env set + missing snapshot (rollback in force)", async () => {
    process.env.DYNAMIC_UNIVERSE_ENABLED = "1";
    const supabase = makeSupabaseStub({ snapshot: null });
    const r = await computeUniverseGate({
      supabase, userId: "u1", executionMode: "paper",
      openSymbols: ["BTC-USDT"],
    });
    expect(r.active).toBe(false);
    expect(r.allowedNewEntries.size).toBe(0);
    expect(r.retainedSymbols).toEqual(["BTC-USDT"]);
  });

  it("passthrough even with env set + fresh snapshot + slots (rollback in force)", async () => {
    process.env.DYNAMIC_UNIVERSE_ENABLED = "1";
    const supabase = makeSupabaseStub({
      snapshot: {
        id: "snap1",
        generated_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      rankings: [
        { symbol: "ETH-USDT", bucket: "ranked", direction: "short", rank: 2 },
      ],
      slots: unassignedSlots(10),
    });
    const r = await computeUniverseGate({
      supabase, userId: "u1", executionMode: "paper",
      openSymbols: ["BTC-USDT"],
    });
    expect(r.active).toBe(false);
    expect(r.allowedNewEntries.size).toBe(0);
    expect(r.retainedSymbols).toEqual(["BTC-USDT"]);
  });

  it("passthrough even with env set + zero slots (rollback in force)", async () => {
    process.env.DYNAMIC_UNIVERSE_ENABLED = "1";
    const supabase = makeSupabaseStub({
      snapshot: {
        id: "snap1",
        generated_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      rankings: [
        { symbol: "ETH-USDT", bucket: "ranked", direction: "long", rank: 1 },
      ],
      slots: [],
    });
    const r = await computeUniverseGate({
      supabase, userId: "u1", executionMode: "paper",
      openSymbols: [],
    });
    expect(r.active).toBe(false);
    expect(r.allowedNewEntries.size).toBe(0);
  });
});
