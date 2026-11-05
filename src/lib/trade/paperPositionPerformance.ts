import type { SupabaseClient } from "@supabase/supabase-js";

export type PaperPerformancePosition = {
  id: string;
  symbol: string;
  strategy: string;
  status: string;
  strategy_metadata?: { detector_strategy?: unknown } | null;
  paper_trades: Array<{ pnl_net: number | string | null; closed_at: string | null }>;
};

/** One observation per FINISHED position, including every partial realization. */
export function paperPositionPerformance(positions: PaperPerformancePosition[]) {
  return positions
    .flatMap((p) => {
      if (p.status !== "closed" || !p.paper_trades.length) return [];
      if (
        p.paper_trades.some(
          (t) =>
            t.pnl_net == null ||
            !Number.isFinite(Number(t.pnl_net)) ||
            !t.closed_at ||
            !Number.isFinite(Date.parse(t.closed_at)),
        )
      )
        return [];
      const closedAt = p.paper_trades.reduce(
        (latest, t) => (Date.parse(t.closed_at!) > Date.parse(latest) ? t.closed_at! : latest),
        p.paper_trades[0].closed_at!,
      );
      const detector = p.strategy_metadata?.detector_strategy;
      const strategy = typeof detector === "string" && detector ? detector : p.strategy;
      return [
        {
          id: p.id,
          symbol: p.symbol,
          strategy,
          pnl: p.paper_trades.reduce((total, t) => total + Number(t.pnl_net), 0),
          closedAt,
        },
      ];
    })
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt));
}

export async function loadPaperPositionPerformance(
  client: SupabaseClient,
  userId: string,
  limit = 200,
) {
  // Limit parents, NOT exit rows: an exit-row LIMIT can cut a losing campaign
  // in half and omit the earlier profitable partial exits (or vice versa).
  const { data, error } = await client
    .from("paper_positions")
    .select("id,symbol,strategy,status,strategy_metadata")
    .eq("user_id", userId)
    .eq("status", "closed")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  if (!data?.length) return [];
  // Production intentionally has no paper_trades -> paper_positions FK, so
  // PostgREST embedding is unavailable. Read every exit for these parents.
  const positions = data.map((p) => ({
    ...p,
    paper_trades: [],
  })) as unknown as PaperPerformancePosition[];
  const byId = new Map(positions.map((p) => [p.id, p]));
  for (let offset = 0; ; offset += 1000) {
    const { data: exits, error: exitError } = await client
      .from("paper_trades")
      .select("position_id,pnl_net,closed_at")
      .eq("user_id", userId)
      .in("position_id", [...byId.keys()])
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (exitError) throw exitError;
    for (const exit of exits ?? []) byId.get(exit.position_id)?.paper_trades.push(exit);
    if ((exits?.length ?? 0) < 1000) break;
  }
  return paperPositionPerformance(positions);
}
