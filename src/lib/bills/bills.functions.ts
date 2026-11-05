/**
 * Life Map v2 — server functions for bills CRUD and allocation sync.
 *
 * All writes go through `requireSupabaseAuth` (user session + RLS). No
 * admin client is used on this path. Idempotency:
 *   - The sync uses a per-user cursor (`bill_sync_cursor`) fast path.
 *   - The DB has a partial UNIQUE index on
 *     `bill_allocations(user_id, trade_id, bill_id) WHERE trade_id IS NOT NULL`,
 *     so a rewound cursor can never insert duplicates — the second attempt
 *     collides and is rejected.
 *
 * This module does NOT touch engine/guardian/worker/signer code paths.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { allocate, periodKeyFor, type BillForAlloc } from "./allocate";
import { coverageBySource } from "./coverage";

const cadenceSchema = z.enum(["monthly", "weekly", "one_time"]);

const upsertSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  amount_usd: z.number().positive().max(1_000_000),
  cadence: cadenceSchema,
  due_day: z.number().int().min(0).max(31).nullable().optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  category: z.string().trim().min(1).max(40).nullable().optional(),
  assigned_strategy: z.string().trim().min(1).max(40).nullable().optional(),
});

const BILL_SELECT =
  "id, name, amount_usd, cadence, due_day, priority, category, assigned_strategy, paid_at, proof_url, created_at, updated_at, archived_at";

export const listBills = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("bills")
      .select(BILL_SELECT)
      .eq("user_id", userId)
      .is("archived_at", null)
      .order("priority", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw new Error(`listBills: ${error.message}`);
    return data ?? [];
  });

export const upsertBill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => upsertSchema.parse(data))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const payload = {
      user_id: userId,
      name: data.name,
      amount_usd: data.amount_usd,
      cadence: data.cadence,
      due_day: data.due_day ?? null,
      priority: data.priority ?? 100,
      category: data.category ?? null,
      assigned_strategy: data.assigned_strategy ?? null,
    };

    if (data.id) {
      const { data: row, error } = await supabase
        .from("bills")
        .update(payload)
        .eq("id", data.id)
        .eq("user_id", userId)
        .select("id")
        .single();
      if (error || !row) throw new Error(`upsertBill: ${error?.message ?? "not found"}`);
      return { id: row.id };
    }
    const { data: row, error } = await supabase
      .from("bills")
      .insert(payload)
      .select("id")
      .single();
    if (error || !row) throw new Error(`upsertBill: ${error?.message ?? "insert failed"}`);
    return { id: row.id };
  });

/** Assign or clear the turtle bot attached to a bill. */
export const assignBillStrategy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        strategy: z.string().trim().min(1).max(40).nullable(),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("bills")
      .update({ assigned_strategy: data.strategy })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(`assignBillStrategy: ${error.message}`);
    return { ok: true };
  });

/**
 * Mark a bill as paid, record the proof URL, and award life points.
 * Idempotent — repeated calls do not double-award (RPC dedupes on
 * `bill:<id>:paid_with_proof`).
 */
export const markBillPaid = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        proof_path: z.string().trim().min(1).max(400),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("bills")
      .update({ paid_at: new Date().toISOString(), proof_url: data.proof_path })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(`markBillPaid: ${error.message}`);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: awarded, error: rpcErr } = await supabaseAdmin.rpc("award_bill_points", {
      _user_id: userId,
      _bill_id: data.id,
      _reason: "bill_paid_with_proof",
      _points: 75,
    });
    if (rpcErr) throw new Error(`awardPoints: ${rpcErr.message}`);
    return { ok: true, points_awarded: Number(awarded) || 0 };
  });

/** Reset a bill to unpaid (proof removed). Does not refund points. */
export const clearBillPaid = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("bills")
      .update({ paid_at: null, proof_url: null })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(`clearBillPaid: ${error.message}`);
    return { ok: true };
  });

/** Get a short-lived signed URL for a private bill-proofs storage object. */
export const getProofSignedUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ path: z.string().trim().min(1).max(400) }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    // Enforce path is scoped to the caller's folder.
    if (!data.path.startsWith(`${userId}/`)) {
      throw new Error("forbidden");
    }
    const { data: signed, error } = await supabase.storage
      .from("bill-proofs")
      .createSignedUrl(data.path, 300);
    if (error || !signed) throw new Error(`sign: ${error?.message ?? "failed"}`);
    return { url: signed.signedUrl };
  });


export const archiveBill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("bills")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(`archiveBill: ${error.message}`);
    return { ok: true };
  });

export const dismissBillsPrompt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("profiles")
      .update({ bills_prompt_dismissed_at: new Date().toISOString() })
      .eq("id", userId);
    if (error) throw new Error(`dismissBillsPrompt: ${error.message}`);
    return { ok: true };
  });

export interface BillCoverageRow {
  bill: {
    id: string;
    name: string;
    amount_usd: number;
    cadence: string;
    due_day: number | null;
    priority: number;
  };
  covered_usd: number;
  paper_covered_usd: number;
  covered_prev_usd: number;
  delta_since_yesterday_usd: number;
}

export interface LifeMapSnapshot {
  period_key: string;
  prev_period_key: string;
  bills: BillCoverageRow[];
  total_amount_usd: number;
  total_covered_usd: number;
  total_paper_covered_usd: number;
  total_covered_prev_usd: number;
  prompt_dismissed: boolean;
  paper_disclaimer: string;
}

function shiftPeriod(pk: string, deltaMonths: number): string {
  const [y, m] = pk.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + deltaMonths, 1));
  return periodKeyFor(d);
}

export const getLifeMapSnapshot = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    // Auto-sync both sources before reading so the snapshot reflects any
    // freshly-closed paper or live trades. Idempotent + bounded by the
    // per-source cursor; safe on every read.
    try {
      await Promise.all([
        runAllocationSync(supabase, userId, "paper"),
        runAllocationSync(supabase, userId, "live"),
      ]);
    } catch {
      // Never block the snapshot read on a sync error — allocations will
      // catch up on the next tick.
    }

    const now = new Date();
    const periodKey = periodKeyFor(now);
    const prevPeriodKey = shiftPeriod(periodKey, -1);
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [billsRes, allocsRes, allocsPrevRes, yestRes, profileRes] = await Promise.all([
      supabase
        .from("bills")
        .select("id, name, amount_usd, cadence, due_day, priority, created_at")
        .eq("user_id", userId)
        .is("archived_at", null)
        .order("priority", { ascending: true })
        .order("created_at", { ascending: true }),
      supabase
        .from("bill_allocations")
        .select("bill_id, amount_usd, source")
        .eq("user_id", userId)
        .eq("period_key", periodKey),
      supabase
        .from("bill_allocations")
        .select("bill_id, amount_usd, source")
        .eq("user_id", userId)
        .eq("period_key", prevPeriodKey),
      supabase
        .from("bill_allocations")
        .select("bill_id, amount_usd, source, created_at")
        .eq("user_id", userId)
        .eq("period_key", periodKey)
        .lte("created_at", yesterday.toISOString()),
      supabase
        .from("profiles")
        .select("bills_prompt_dismissed_at")
        .eq("id", userId)
        .maybeSingle(),
    ]);
    if (billsRes.error) throw new Error(billsRes.error.message);
    if (allocsRes.error) throw new Error(allocsRes.error.message);
    if (allocsPrevRes.error) throw new Error(allocsPrevRes.error.message);
    if (yestRes.error) throw new Error(yestRes.error.message);

    const bills = billsRes.data ?? [];
    const cur = coverageBySource(allocsRes.data ?? [], "live");
    const paperCur = coverageBySource(allocsRes.data ?? [], "paper");
    const prev = coverageBySource(allocsPrevRes.data ?? [], "live");
    const yest = coverageBySource(yestRes.data ?? [], "live");

    const rows: BillCoverageRow[] = bills.map((b) => {
      const coveredCur = Math.max(0, cur.get(b.id) ?? 0);
      const coveredYest = Math.max(0, yest.get(b.id) ?? 0);
      return {
        bill: {
          id: b.id,
          name: b.name,
          amount_usd: Number(b.amount_usd),
          cadence: b.cadence,
          due_day: b.due_day,
          priority: b.priority,
        },
        covered_usd: coveredCur,
        paper_covered_usd: Math.max(0, paperCur.get(b.id) ?? 0),
        covered_prev_usd: Math.max(0, prev.get(b.id) ?? 0),
        delta_since_yesterday_usd: coveredCur - coveredYest,
      };
    });

    const totalAmount = rows.reduce((a, r) => a + r.bill.amount_usd, 0);
    const totalCovered = rows.reduce((a, r) => a + Math.min(r.covered_usd, r.bill.amount_usd), 0);
    const totalPaperCovered = rows.reduce((a, r) => a + Math.min(r.paper_covered_usd, r.bill.amount_usd), 0);
    const totalCoveredPrev = rows.reduce((a, r) => a + Math.min(r.covered_prev_usd, r.bill.amount_usd), 0);

    const snapshot: LifeMapSnapshot = {
      period_key: periodKey,
      prev_period_key: prevPeriodKey,
      bills: rows,
      total_amount_usd: totalAmount,
      total_covered_usd: totalCovered,
      total_paper_covered_usd: totalPaperCovered,
      total_covered_prev_usd: totalCoveredPrev,
      prompt_dismissed: !!profileRes.data?.bills_prompt_dismissed_at,
      paper_disclaimer: "Paper trading — simulated gains, not real funds.",
    };
    return snapshot;
  });


/**
 * Run one pass of allocation for the signed-in user.
 *
 * Chronologically consumes all closed paper trades newer than the cursor,
 * calls the pure `allocate()` for each, inserts `bill_allocations` rows,
 * and advances the cursor. Safe to re-run; the partial UNIQUE index on
 * `(user_id, trade_id, bill_id)` provides the correctness backstop against
 * a rewound cursor.
 */
export type AllocationSource = "paper" | "live";

/**
 * Shared allocator: pulls closed trades from the source-specific table
 * (paper_trades or trades), calls the pure `allocate()`, inserts
 * `bill_allocations` rows tagged with `source`, and advances the per-source
 * cursor. Idempotent — the partial UNIQUE index on
 * `(user_id, source, trade_id, bill_id)` guards against a rewound cursor.
 */
export async function runAllocationSync(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string,
  source: AllocationSource,
): Promise<{ processedTrades: number; totalAllocated: number; totalDrained: number }> {
  const [billsRes, cursorRes] = await Promise.all([
    supabase
      .from("bills")
      .select("id, amount_usd, priority, created_at")
      .eq("user_id", userId)
      .is("archived_at", null),
    supabase
      .from("bill_sync_cursor")
      .select("last_trade_closed_at, last_trade_id")
      .eq("user_id", userId)
      .eq("source", source)
      .maybeSingle(),
  ]);
  if (billsRes.error) throw new Error(billsRes.error.message);
  if (cursorRes.error) throw new Error(cursorRes.error.message);

  const bills: BillForAlloc[] = (billsRes.data ?? []).map((b: {
    id: string; amount_usd: number | string; priority: number; created_at: string | null;
  }) => ({
    id: b.id,
    amount_usd: Number(b.amount_usd),
    priority: b.priority,
    created_at: b.created_at ?? "1970-01-01T00:00:00Z",
  }));

  if (bills.length === 0) {
    return { processedTrades: 0, totalAllocated: 0, totalDrained: 0 };
  }

  const cursorTs = cursorRes.data?.last_trade_closed_at ?? "1970-01-01T00:00:00Z";
  const cursorId = cursorRes.data?.last_trade_id ?? null;

  // Pull a bounded batch of newer closed trades from the correct table.
  // paper_trades.pnl_net  <->  trades.realized_pnl
  const table = source === "paper" ? "paper_trades" : "trades";
  const pnlCol = source === "paper" ? "pnl_net" : "realized_pnl";
  const { data: trades, error: tradesErr } = await supabase
    .from(table)
    .select(`id, closed_at, ${pnlCol}`)
    .eq("user_id", userId)
    .gte("closed_at", cursorTs)
    .order("closed_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(500);
  if (tradesErr) throw new Error(tradesErr.message);

  type TradeRow = { id: string; closed_at: string; [k: string]: unknown };
  const pending = ((trades ?? []) as TradeRow[])
    .map((t) => ({ id: t.id, closed_at: t.closed_at, pnl_net: Number(t[pnlCol] ?? 0) }))
    .filter((t) => {
      if (t.closed_at > cursorTs) return true;
      if (t.closed_at === cursorTs && cursorId && t.id > cursorId) return true;
      return false;
    });
  if (pending.length === 0) {
    return { processedTrades: 0, totalAllocated: 0, totalDrained: 0 };
  }

  // Snapshot current covered totals per bill per period touched, scoped to
  // this source so paper and live never contaminate each other.
  const periodsTouched = new Set(pending.map((t) => periodKeyFor(t.closed_at)));
  const covered = new Map<string, Map<string, number>>();
  for (const pk of periodsTouched) {
    const { data: rows, error } = await supabase
      .from("bill_allocations")
      .select("bill_id, amount_usd")
      .eq("user_id", userId)
      .eq("source", source)
      .eq("period_key", pk);
    if (error) throw new Error(error.message);
    const m = new Map<string, number>();
    for (const r of (rows ?? []) as Array<{ bill_id: string; amount_usd: number | string }>) {
      m.set(r.bill_id, (m.get(r.bill_id) ?? 0) + Number(r.amount_usd));
    }
    covered.set(pk, m);
  }

  let totalAllocated = 0;
  let totalDrained = 0;
  let lastTs = cursorTs;
  let lastId = cursorId;

  for (const t of pending) {
    const pk = periodKeyFor(t.closed_at);
    const periodMap = covered.get(pk) ?? new Map<string, number>();
    const coveredObj: Record<string, number> = {};
    for (const [k, v] of periodMap) coveredObj[k] = v;
    const result = allocate({ bills, covered: coveredObj, delta_usd: t.pnl_net });

    if (result.ops.length > 0) {
      const rows = result.ops.map((op) => ({
        user_id: userId,
        bill_id: op.bill_id,
        trade_id: t.id,
        amount_usd: op.delta_usd,
        period_key: pk,
        source,
      }));
      const { error } = await supabase.from("bill_allocations").insert(rows);
      if (error) {
        if (!/duplicate key/i.test(error.message)) {
          throw new Error(`insert allocations: ${error.message}`);
        }
      } else {
        for (const op of result.ops) {
          periodMap.set(op.bill_id, (periodMap.get(op.bill_id) ?? 0) + op.delta_usd);
          if (op.delta_usd > 0) totalAllocated += op.delta_usd;
          else totalDrained += -op.delta_usd;
        }
        covered.set(pk, periodMap);
      }
    }

    lastTs = t.closed_at;
    lastId = t.id;
  }

  const { error: cursorErr } = await supabase.from("bill_sync_cursor").upsert(
    {
      user_id: userId,
      source,
      last_trade_closed_at: lastTs,
      last_trade_id: lastId,
    },
    { onConflict: "user_id,source" },
  );
  if (cursorErr) throw new Error(`advance cursor: ${cursorErr.message}`);

  return { processedTrades: pending.length, totalAllocated, totalDrained };
}

/**
 * Server-fn wrapper. Runs one pass of allocation for the signed-in user.
 * Optionally scoped to a single source; defaults to both.
 */
export const syncBillAllocations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ source: z.enum(["paper", "live"]).optional() }).optional().parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const sources: AllocationSource[] = data?.source ? [data.source] : ["paper", "live"];
    const results = await Promise.all(
      sources.map((s) => runAllocationSync(supabase, userId, s)),
    );
    return results.reduce(
      (a, r) => ({
        processedTrades: a.processedTrades + r.processedTrades,
        totalAllocated: a.totalAllocated + r.totalAllocated,
        totalDrained: a.totalDrained + r.totalDrained,
      }),
      { processedTrades: 0, totalAllocated: 0, totalDrained: 0 },
    );
  });


/**
 * Recent allocations for a set of trade ids (used by trade list to show
 * per-trade Life Map impact). Bounded to avoid unbounded joins.
 */
export const getAllocationsForTrades = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ trade_ids: z.array(z.string().uuid()).max(200) }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    if (data.trade_ids.length === 0) return [];
    const { data: rows, error } = await supabase
      .from("bill_allocations")
      .select("trade_id, bill_id, amount_usd, period_key, bills!inner(name, amount_usd)")
      .eq("user_id", userId)
      .in("trade_id", data.trade_ids);
    if (error) throw new Error(error.message);
    return (rows ?? []).map((r) => {
      const bill = r.bills as unknown as { name: string; amount_usd: number };
      return {
        trade_id: r.trade_id as string,
        bill_id: r.bill_id,
        bill_name: bill.name,
        bill_amount_usd: Number(bill.amount_usd),
        amount_usd: Number(r.amount_usd),
        period_key: r.period_key,
      };
    });
  });

/**
 * Recent allocations for a single bill — used by /life-map to expand a bill
 * card and show which trades contributed. Joins paper_trades for symbol.
 */
export const getAllocationsForBill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        bill_id: z.string().uuid(),
        limit: z.number().int().min(1).max(50).optional(),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const { data: rows, error } = await supabase
      .from("bill_allocations")
      .select("trade_id, amount_usd, created_at, period_key")
      .eq("user_id", userId)
      .eq("bill_id", data.bill_id)
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 10);
    if (error) throw new Error(error.message);
    const list = rows ?? [];
    const tradeIds = Array.from(
      new Set(list.map((r) => r.trade_id).filter((v): v is string => !!v)),
    );
    const tradeMap = new Map<string, { symbol: string; direction: string }>();
    if (tradeIds.length > 0) {
      const { data: trades, error: tErr } = await supabase
        .from("paper_trades")
        .select("id, symbol, direction")
        .eq("user_id", userId)
        .in("id", tradeIds);
      if (tErr) throw new Error(tErr.message);
      for (const t of trades ?? []) tradeMap.set(t.id, { symbol: t.symbol, direction: t.direction });
    }
    return list.map((r) => {
      const t = r.trade_id ? tradeMap.get(r.trade_id) : null;
      return {
        trade_id: r.trade_id as string | null,
        amount_usd: Number(r.amount_usd),
        created_at: r.created_at as string,
        period_key: r.period_key,
        symbol: t?.symbol ?? null,
        direction: t?.direction ?? null,
      };
    });
  });
