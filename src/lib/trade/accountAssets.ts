/** Select one book; never substitute live money for an unavailable paper account. */
export function accountAssetTotals(
  book: "paper" | "live",
  paper: { equity: number | null; available: number | null; isLoading: boolean; source: string },
  live: {
    totalUsd: number;
    available: number;
    allocated: number;
    isLoading: boolean;
    hasError: boolean;
  },
) {
  if (book === "live")
    return {
      equity: live.totalUsd,
      available: live.available,
      allocated: live.allocated,
      isLoading: live.isLoading,
      hasError: live.hasError,
    };
  const valid =
    paper.source === "paper_account" &&
    paper.equity != null &&
    paper.available != null &&
    Number.isFinite(paper.equity) &&
    Number.isFinite(paper.available);
  return {
    equity: valid ? paper.equity : null,
    available: valid ? paper.available : null,
    allocated: valid ? Math.max(0, paper.equity! - paper.available!) : null,
    isLoading: paper.isLoading,
    hasError: !paper.isLoading && !valid,
  };
}
