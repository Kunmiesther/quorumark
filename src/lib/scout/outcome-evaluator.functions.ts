/**
 * Scout outcome evaluator — READ-ONLY.
 *
 * Evaluates closed 15m/1h/4h/24h windows for signals via the deterministic
 * `evaluateOutcome` pure module. Persists via `scout_outcomes` (owner-scoped
 * RLS). Corrections append via `supersedes_id` — existing rows are never
 * mutated.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { sharedMarketCache } from "./marketCache";
import { OUTCOME_SCHEMA_VERSION, RULES_VERSION } from "./versions";
import { evaluateOutcome, WINDOW_MS, type WindowKey } from "./outcome";
import type { Candle } from "@/lib/paper/signal";

const MAX_SIGNALS = 100;

interface SignalRow {
  id: string;
  symbol: string;
  bias: string;
  created_at: string;
  weighted_score: number | null;
}

export const runOutcomeEvaluator = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ evaluated: number; appended: number; skipped: number }> => {
    const { supabase, userId } = context;
    const now = Date.now();
    const cache = sharedMarketCache();

    const cutoff = new Date(now - WINDOW_MS["15m"]).toISOString();
    const { data: signals, error } = await supabase
      .from("scout_signals")
      .select("id, symbol, bias, created_at, weighted_score")
      .eq("user_id", userId)
      .lte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(MAX_SIGNALS);
    if (error || !signals || signals.length === 0) {
      return { evaluated: 0, appended: 0, skipped: 0 };
    }

    const signalIds = signals.map((s) => s.id as string);
    const { data: existing } = await supabase
      .from("scout_outcomes")
      .select("signal_id, window_key")
      .in("signal_id", signalIds)
      .is("supersedes_id", null);
    const have = new Set<string>();
    for (const o of existing ?? []) have.add(`${o.signal_id}|${o.window_key}`);

    let appended = 0;
    let skipped = 0;
    let evaluated = 0;

    for (const s of signals as unknown as SignalRow[]) {
      const dir: "long" | "short" | null =
        s.bias === "long-priority" ? "long" :
        s.bias === "short-priority" ? "short" : null;
      if (!dir) continue;

      let candles: Candle[] = [];
      try {
        candles = await cache.getCandles(s.symbol, "M5", now);
      } catch { continue; }
      if (candles.length === 0) continue;

      const openedAtMs = new Date(s.created_at).getTime();
      const forward = candles.filter((c) => c[0] >= openedAtMs);
      if (forward.length < 3) continue;
      const entryPrice = forward[0][4];
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;

      const report = evaluateOutcome({
        entry_price: entryPrice,
        direction: dir,
        score: Number(s.weighted_score ?? 0),
        entry_ts_ms: openedAtMs,
        now,
        forward_candles: forward,
      });
      evaluated++;

      for (const w of report.windows) {
        if (w.status !== "complete") continue;
        const key = `${s.id}|${w.window}`;
        if (have.has(key)) { skipped++; continue; }
        const observedUntil = new Date(openedAtMs + WINDOW_MS[w.window as WindowKey]).toISOString();
        const { error: insErr } = await supabase.from("scout_outcomes").insert({
          user_id: userId,
          signal_id: s.id,
          window_key: w.window,
          status: w.status,
          mfe_pct: w.mfe_pct,
          mae_pct: w.mae_pct,
          net_pct: w.net_pct,
          target_hit: w.target_hit,
          hit_invalidation: w.invalidation_hit,
          bars_used: w.bars_used,
          reason_codes: w.reason_codes,
          observed_until: observedUntil,
          outcome_schema_version: OUTCOME_SCHEMA_VERSION,
          rules_version: RULES_VERSION,
        });
        if (!insErr) appended++;
      }
    }

    return { evaluated, appended, skipped };
  });
