import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { ManualCouncilDraft } from "./manualCouncil.functions";

export async function performManualCouncilReview(data: ManualCouncilDraft, context: { supabase: SupabaseClient<Database>; userId: string }) {
    if (data.connectionId) {
      const { data: connection, error } = await context.supabase
        .from("exchange_connections")
        .select("exchange")
        .eq("id", data.connectionId)
        .eq("user_id", context.userId)
        .maybeSingle();
      if (error || !connection)
        throw new Error("The selected exchange account could not be verified.");
      const expected = data.exchange === "ApeX Omni" ? "apex_omni" : data.exchange.toLowerCase();
      if (connection.exchange !== expected)
        throw new Error("Council venue does not match the selected account.");
    }
    const [{ publicCouncilCandles }, { evaluateSnapshot }, { canonicalJson }] = await Promise.all([
      import("./publicCouncilCandles.server"),
      import("@/lib/ai/committee/evaluate.server"),
      import("@/lib/ai/committee/schema"),
    ]);
    const candles = await publicCouncilCandles(data.exchange, data.symbol);
    const last = candles.at(-1);
    if (!last || candles.length < 40)
      throw new Error("Not enough completed venue candles for Council review.");
    const closeMs = last[0] + 300_000;
    if (Date.now() - closeMs > 900_000)
      throw new Error("Venue candles are stale; Council review was not fabricated.");
    const { createHash } = await import("node:crypto");
    const id = createHash("sha256").update(canonicalJson({ data, closeMs })).digest("hex");
    const entry = data.kind === "limit" ? data.limitPrice : last[4];
    const result = await evaluateSnapshot(context.supabase, context.userId, {
      candidate_id: `manual:${id}`,
      strategy: "manual_ticket",
      symbol: data.symbol,
      timeframe: "5m",
      candle_close_ms: closeMs,
      manual_ticket: data,
      deterministic: {
        proposed_direction: data.side,
        entry,
        entry_zone: entry ? { low: entry, high: entry } : null,
        invalidation: data.stopLoss,
        tp_levels: data.takeProfit ? [data.takeProfit] : [],
        regime: null,
        trend_state: null,
        trend_slope_pct: null,
        atr_pct: null,
        recent_closes: candles.map((c) => c[4]),
        recent_highs: candles.map((c) => c[2]),
        recent_lows: candles.map((c) => c[3]),
        volume_profile: candles.map((c) => c[5]),
      },
    });
    if (!result) throw new Error("Council review could not be recorded. No order was sent.");
    return result;
}
