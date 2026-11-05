export type CoverageSource = "live" | "paper";
export type CoverageAllocation = {
  bill_id: string;
  amount_usd: number;
  source: string;
};

/** Historical unscoped reallocation rows are intentionally excluded. */
export function coverageBySource(
  rows: CoverageAllocation[],
  source: CoverageSource,
): Map<string, number> {
  const covered = new Map<string, number>();
  for (const row of rows) {
    if (row.source !== source && !(source === "live" && row.source === "reallocation_live")) continue;
    covered.set(row.bill_id, (covered.get(row.bill_id) ?? 0) + Number(row.amount_usd));
  }
  return covered;
}
