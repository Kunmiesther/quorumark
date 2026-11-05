/**
 * Life Map v2 — surplus reallocation: detect, list, apply, dismiss.
 *
 * Same conventions as bills.functions.ts: writes go through the caller's
 * RLS-scoped client wherever a policy permits it (see the migration that
 * created bill_reallocation_suggestions); the Telegram send is the only
 * side effect that reaches outside this user's own rows.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { periodKeyFor } from "./allocate";
import { suggestReallocations, type BillCoverage } from "./reallocate";

interface BillRow {
  id: string;
  name: string;
  amount_usd: number;
}

/**
 * Recompute live coverage for the user's active bills in the current
 * period. Shared by detect (fresh suggestions) and apply (re-verify before
 * writing bill_allocations, since state can drift between suggestion and
 * confirmation).
 */
async function loadCoverage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string,
): Promise<{ periodKey: string; bills: Map<string, BillRow>; coverage: BillCoverage[] }> {
  const periodKey = periodKeyFor(new Date());
  const [billsRes, allocsRes] = await Promise.all([
    supabase
      .from("bills")
      .select("id, name, amount_usd")
      .eq("user_id", userId)
      .is("archived_at", null),
    supabase
      .from("bill_allocations")
      .select("bill_id, amount_usd")
      .eq("user_id", userId)
      .eq("period_key", periodKey)
      .in("source", ["live", "reallocation_live"]),
  ]);
  if (billsRes.error) throw new Error(billsRes.error.message);
  if (allocsRes.error) throw new Error(allocsRes.error.message);

  const bills = new Map<string, BillRow>();
  for (const b of (billsRes.data ?? []) as Array<{ id: string; name: string; amount_usd: number | string }>) {
    bills.set(b.id, { id: b.id, name: b.name, amount_usd: Number(b.amount_usd) });
  }
  const covered = new Map<string, number>();
  for (const a of (allocsRes.data ?? []) as Array<{ bill_id: string; amount_usd: number | string }>) {
    covered.set(a.bill_id, (covered.get(a.bill_id) ?? 0) + Number(a.amount_usd));
  }
  const coverage: BillCoverage[] = Array.from(bills.values()).map((b) => ({
    id: b.id,
    amount_usd: b.amount_usd,
    covered_usd: Math.max(0, covered.get(b.id) ?? 0),
  }));

  return { periodKey, bills, coverage };
}

export interface ReallocationSuggestionView {
  id: string;
  source_bill_id: string;
  source_bill_name: string;
  surplus_usd: number;
  targets: Array<{ bill_id: string; bill_name: string; amount_usd: number }>;
}

/**
 * Recompute suggestions from live coverage, persist any new ones (the
 * partial unique index on (user_id, source_bill_id, period_key) WHERE
 * pending guards against re-inserting one already open), and notify
 * Telegram for genuinely new ones. Returns the full current pending list.
 *
 * Safe to call often — existing pending suggestions are read back, not
 * recreated or re-notified.
 */
export async function detectReallocationSuggestions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string,
): Promise<ReallocationSuggestionView[]> {
  const { periodKey, bills, coverage } = await loadCoverage(supabase, userId);
  if (coverage.length < 2) return [];

  const computed = suggestReallocations(coverage);
  const newlyInserted: string[] = [];

  for (const s of computed) {
    const { data, error } = await supabase
      .from("bill_reallocation_suggestions")
      .insert({
        user_id: userId,
        source_bill_id: s.source_bill_id,
        period_key: periodKey,
        surplus_usd: s.surplus_usd,
        targets: s.targets,
      })
      .select("id")
      .single();
    if (!error && data) {
      newlyInserted.push(data.id as string);
    } else if (error && !/duplicate key/i.test(error.message)) {
      throw new Error(`detectReallocationSuggestions: ${error.message}`);
    }
  }

  const { data: pending, error: pendErr } = await supabase
    .from("bill_reallocation_suggestions")
    .select("id, source_bill_id, surplus_usd, targets, notified_telegram_at")
    .eq("user_id", userId)
    .eq("status", "pending")
    .eq("period_key", periodKey);
  if (pendErr) throw new Error(`detectReallocationSuggestions: ${pendErr.message}`);

  const view: ReallocationSuggestionView[] = ((pending ?? []) as Array<{
    id: string;
    source_bill_id: string;
    surplus_usd: number | string;
    targets: Array<{ bill_id: string; amount_usd: number }>;
    notified_telegram_at: string | null;
  }>).map((row) => ({
    id: row.id,
    source_bill_id: row.source_bill_id,
    source_bill_name: bills.get(row.source_bill_id)?.name ?? "a bill",
    surplus_usd: Number(row.surplus_usd),
    targets: row.targets.map((t) => ({
      bill_id: t.bill_id,
      bill_name: bills.get(t.bill_id)?.name ?? "a bill",
      amount_usd: Number(t.amount_usd),
    })),
  }));

  const toNotify = view.filter((v) => newlyInserted.includes(v.id));
  if (toNotify.length > 0) {
    try {
      await notifyTelegram(supabase, userId, toNotify);
    } catch {
      // Best-effort — the in-app banner is the source of truth either way.
    }
  }

  return view;
}

async function notifyTelegram(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string,
  suggestions: ReallocationSuggestionView[],
): Promise<void> {
  const { data: account } = await supabase
    .from("telegram_accounts")
    .select("chat_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (!account?.chat_id) return;

  const { sendMessage } = await import("@/lib/telegram/api.server");
  for (const s of suggestions) {
    const targetList = s.targets.map((t) => `${t.bill_name} ($${t.amount_usd.toFixed(2)})`).join(" + ");
    const text =
      `💰 <b>${s.source_bill_name}</b> has accumulated $${s.surplus_usd.toFixed(2)} more than it needs.\n\n` +
      `That's enough to cover: ${targetList}.\n\nApply it?`;
    await sendMessage(account.chat_id, text, {
      buttons: [[
        { text: "✅ Apply", callback_data: `apply_realloc:${s.id}` },
        { text: "Skip", callback_data: `dismiss_realloc:${s.id}` },
      ]],
    });
  }
  await supabase
    .from("bill_reallocation_suggestions")
    .update({ notified_telegram_at: new Date().toISOString() })
    .in("id", suggestions.map((s) => s.id));
}

export const listPendingReallocationSuggestions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ReallocationSuggestionView[]> => {
    return detectReallocationSuggestions(context.supabase, context.userId);
  });

export type ApplyReallocationResult =
  | { ok: true; surplus_usd: number; targets: Array<{ bill_id: string; amount_usd: number }> }
  | { ok: false; reason: "not_found" | "surplus_no_longer_available" };

/**
 * Apply one suggestion. Re-verifies against LIVE coverage first (state may
 * have drifted since the suggestion was created) and applies whatever
 * surplus/targets are valid right now — never the possibly-stale stored
 * amounts. If nothing valid remains, the suggestion is dismissed instead of
 * silently no-opping.
 *
 * Plain function so both the authenticated server-fn wrapper (web app) and
 * the Telegram webhook (admin client, userId from telegram_accounts) can
 * call it — mirrors runAllocationSync / syncBillAllocations in
 * bills.functions.ts.
 */
export async function applyReallocation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string,
  suggestionId: string,
): Promise<ApplyReallocationResult> {
  const { data: row, error: rowErr } = await supabase
    .from("bill_reallocation_suggestions")
    .select("id, source_bill_id, status")
    .eq("id", suggestionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (rowErr) throw new Error(`applyReallocation: ${rowErr.message}`);
  if (!row || row.status !== "pending") return { ok: false, reason: "not_found" };

  const { periodKey, coverage } = await loadCoverage(supabase, userId);
  const fresh = suggestReallocations(coverage).find((s) => s.source_bill_id === row.source_bill_id);

  const resolve = async (status: "applied" | "dismissed") => {
    await supabase
      .from("bill_reallocation_suggestions")
      .update({ status, resolved_at: new Date().toISOString() })
      .eq("id", suggestionId)
      .eq("user_id", userId);
  };

  if (!fresh || fresh.targets.length === 0) {
    await resolve("dismissed");
    return { ok: false, reason: "surplus_no_longer_available" };
  }

  const rows = [
    { user_id: userId, bill_id: fresh.source_bill_id, amount_usd: -fresh.surplus_usd, period_key: periodKey, source: "reallocation_live" },
    ...fresh.targets.map((t) => ({
      user_id: userId,
      bill_id: t.bill_id,
      amount_usd: t.amount_usd,
      period_key: periodKey,
      source: "reallocation_live",
    })),
  ];
  const { error: insErr } = await supabase.from("bill_allocations").insert(rows);
  if (insErr) throw new Error(`applyReallocation: ${insErr.message}`);

  await resolve("applied");
  return { ok: true, surplus_usd: fresh.surplus_usd, targets: fresh.targets };
}

export async function dismissReallocation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string,
  suggestionId: string,
): Promise<{ ok: boolean }> {
  const { error } = await supabase
    .from("bill_reallocation_suggestions")
    .update({ status: "dismissed", resolved_at: new Date().toISOString() })
    .eq("id", suggestionId)
    .eq("user_id", userId);
  if (error) throw new Error(`dismissReallocation: ${error.message}`);
  return { ok: true };
}

export const applyReallocationSuggestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => applyReallocation(context.supabase, context.userId, data.id));

export const dismissReallocationSuggestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => dismissReallocation(context.supabase, context.userId, data.id));
