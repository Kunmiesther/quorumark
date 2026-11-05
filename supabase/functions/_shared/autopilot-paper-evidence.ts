/** Portable across the web server and Edge Functions; never infer plan ownership. */
type QueryResult = { data: Record<string, unknown>[] | null; error: unknown };
interface Query extends PromiseLike<QueryResult> {
  eq(column: string, value: unknown): Query;
  gte(column: string, value: string): Query;
  in(column: string, values: string[]): Query;
  order(column: string, options: { ascending: boolean }): Query;
  range(from: number, to: number): Query;
}
export type PaperEvidenceReader = { from(table: string): { select(columns: string): Query } };

export function hasLiveExecutionRows(proposal: unknown, rows: ReadonlyArray<{ mode: string }>) {
  const book =
    proposal && typeof proposal === "object" && !Array.isArray(proposal)
      ? (proposal as Record<string, unknown>).setupBook
      : undefined;
  // Disabled live rows still belong to the live book, not to simulation.
  return book === "live" || rows.some((row) => row.mode === "live");
}

export async function readWorkflowPaperEvidence(
  reader: PaperEvidenceReader,
  userId: string,
  workflowId: string,
  approvedAt: string,
): Promise<Array<{ pnl_net: number; closed_at: string }>> {
  const ids: string[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await reader
      .from("paper_positions")
      .select("id")
      .eq("user_id", userId)
      .eq("strategy_metadata->>autopilot_workflow_id", workflowId)
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error("Could not read plan position attribution.");
    for (const row of data ?? []) ids.push(String(row.id));
    if ((data?.length ?? 0) < pageSize) break;
  }
  const trades: Array<{ pnl_net: number; closed_at: string }> = [];
  for (let start = 0; start < ids.length; start += 100) {
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await reader
        .from("paper_trades")
        .select("id,pnl_net,closed_at")
        .eq("user_id", userId)
        .in("position_id", ids.slice(start, start + 100))
        .gte("closed_at", approvedAt)
        .order("id", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw new Error("Could not read attributed paper trades.");
      for (const row of data ?? []) {
        if (row.pnl_net === null || row.pnl_net === "" || !Number.isFinite(Number(row.pnl_net)))
          throw new Error("Attributed paper P&L is unavailable.");
        trades.push({ pnl_net: Number(row.pnl_net), closed_at: String(row.closed_at) });
      }
      if ((data?.length ?? 0) < pageSize) break;
    }
  }
  return trades.sort((a, b) => a.closed_at.localeCompare(b.closed_at));
}
