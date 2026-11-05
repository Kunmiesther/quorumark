/**
 * Owner-scoped read of the live advisory ledger. RLS-scoped to the caller.
 * Read-only; carries no trading authority.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface LiveAdvisoryOpinionView {
  role: string;
  provider: string;
  model: string;
  available: boolean;
  unavailable_reason: string | null;
  latency_ms: number;
  action: string | null;
  confidence: number | null;
  rationale: string | null;
}

export interface LiveAdvisoryView {
  id: string;
  symbol: string;
  direction: string;
  candle_close_at: string;
  consensus_action: string;
  consensus_confidence: number | null;
  seats_available: number;
  seats_total: number;
  narrative: string;
  risk_flags: string[];
  opinions: LiveAdvisoryOpinionView[];
}

export const listLiveAdvisories = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<LiveAdvisoryView[]> => {
    const { supabase, userId } = context;
    const { data } = await supabase
      .from("live_position_advisories" as never)
      .select(
        "id,symbol,direction,candle_close_at,consensus_action,consensus_confidence,seats_available,seats_total,narrative,risk_check",
      )
      .eq("user_id", userId)
      .order("candle_close_at", { ascending: false })
      .limit(10);

    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (!rows.length) return [];

    const ids = rows.map((r) => String(r.id));
    const { data: ops } = await supabase
      .from("live_position_advisory_opinions" as never)
      .select("advisory_id,role,provider,model,available,unavailable_reason,latency_ms,action,confidence,rationale")
      .in("advisory_id", ids);

    const byAdvisory = new Map<string, LiveAdvisoryOpinionView[]>();
    for (const o of (ops ?? []) as unknown as Array<Record<string, unknown>>) {
      const key = String(o.advisory_id);
      const list = byAdvisory.get(key) ?? [];
      list.push({
        role: String(o.role ?? ""),
        provider: String(o.provider ?? ""),
        model: String(o.model ?? ""),
        available: Boolean(o.available),
        unavailable_reason: o.unavailable_reason == null ? null : String(o.unavailable_reason),
        latency_ms: Number(o.latency_ms ?? 0),
        action: o.action == null ? null : String(o.action),
        confidence: o.confidence == null ? null : Number(o.confidence),
        rationale: o.rationale == null ? null : String(o.rationale),
      });
      byAdvisory.set(key, list);
    }

    return rows.map((r) => {
      const risk = (r.risk_check ?? {}) as { flags?: unknown };
      return {
        id: String(r.id),
        symbol: String(r.symbol ?? ""),
        direction: String(r.direction ?? ""),
        candle_close_at: String(r.candle_close_at ?? ""),
        consensus_action: String(r.consensus_action ?? "no_change"),
        consensus_confidence: r.consensus_confidence == null ? null : Number(r.consensus_confidence),
        seats_available: Number(r.seats_available ?? 0),
        seats_total: Number(r.seats_total ?? 0),
        narrative: String(r.narrative ?? ""),
        risk_flags: Array.isArray(risk.flags) ? (risk.flags as string[]) : [],
        opinions: byAdvisory.get(String(r.id)) ?? [],
      };
    });
  });
