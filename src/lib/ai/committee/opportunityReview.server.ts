/** Read-only market review, write-only outcome ledger. No execution imports. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchApexKlines } from "@/lib/paper/feed";
import {
  evaluateMissedOpportunity,
  OPPORTUNITY_METHOD_VERSION,
  OPPORTUNITY_WINDOWS,
  type OpportunityWindow,
} from "./opportunityOutcome";

type OpportunityRow = {
  id: string;
  symbol: string;
  direction: "long" | "short";
  reference_price: number;
  decision_at: string;
};

const LOOKBACK_HOURS = 34; // 140 venue 15m bars cover at most 35h.
const MAX_ROWS = 1_200;
const WINDOWS = Object.keys(OPPORTUNITY_WINDOWS) as OpportunityWindow[];

export async function reviewMissedOpportunities(
  client: SupabaseClient,
  nowMs = Date.now(),
): Promise<{ scanned: number; appended: number; feedErrors: number; backlogTruncated: boolean }> {
  const { data, error } = await client
    .from("missed_opportunities")
    .select("id, symbol, direction, reference_price, decision_at")
    .gte("decision_at", new Date(nowMs - LOOKBACK_HOURS * 3_600_000).toISOString())
    .lte("decision_at", new Date(nowMs - OPPORTUNITY_WINDOWS["1h"]).toISOString())
    .order("decision_at", { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw error;
  const opportunities = (data ?? []) as OpportunityRow[];
  if (!opportunities.length) return { scanned: 0, appended: 0, feedErrors: 0, backlogTruncated: false };

  const existing = new Set<string>();
  for (let offset = 0; offset < opportunities.length; offset += 100) {
    const ids = opportunities.slice(offset, offset + 100).map((row) => row.id);
    const result = await client
      .from("missed_opportunity_outcomes")
      .select("opportunity_id, window_key")
      .in("opportunity_id", ids);
    if (result.error) throw result.error;
    for (const row of result.data ?? []) existing.add(`${row.opportunity_id}|${row.window_key}`);
  }

  const pending = opportunities.flatMap((row) => WINDOWS
    .filter((window) =>
      nowMs >= Date.parse(row.decision_at) + OPPORTUNITY_WINDOWS[window] &&
      !existing.has(`${row.id}|${window}`),
    )
    .map((window) => ({ row, window })));
  const symbols = [...new Set(pending.map(({ row }) => row.symbol))];
  const candles = new Map<string, Awaited<ReturnType<typeof fetchApexKlines>>["candles"]>();
  let feedErrors = 0;
  for (const symbol of symbols) {
    try {
      candles.set(symbol, (await fetchApexKlines(symbol, 15, 140)).candles);
    } catch {
      feedErrors++;
    }
  }

  const outcomeRows: Array<Record<string, unknown>> = [];
  for (const { row, window } of pending) {
    const feed = candles.get(row.symbol);
    if (!feed) continue; // Retry after a transient venue outage.
    const result = evaluateMissedOpportunity({
      direction: row.direction,
      referencePrice: Number(row.reference_price),
      decisionAtMs: Date.parse(row.decision_at),
      nowMs,
      window,
      candles: feed,
    });
    if (!result) continue;
    outcomeRows.push({
      opportunity_id: row.id,
      window_key: window,
      ...result,
      method_version: OPPORTUNITY_METHOD_VERSION,
    });
  }
  let appended = 0;
  for (let offset = 0; offset < outcomeRows.length; offset += 100) {
    const write = await client.from("missed_opportunity_outcomes")
      .upsert(outcomeRows.slice(offset, offset + 100), {
        onConflict: "opportunity_id,window_key",
        ignoreDuplicates: true, // Append-only even if a concurrent cron already won.
      })
      .select("id");
    if (write.error) throw write.error;
    appended += write.data?.length ?? 0;
  }
  return {
    scanned: opportunities.length,
    appended,
    feedErrors,
    backlogTruncated: opportunities.length === MAX_ROWS,
  };
}
