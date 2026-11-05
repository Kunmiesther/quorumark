/**
 * ONYX approval gate (pure).
 *
 * Given the ranked universe, capacity summary, and the current open-position
 * set, decide which symbols get promoted to `approved` for this tick.
 *
 * Retention invariant: active positions keep their symbol and their slot
 * regardless of the current rank. A newly-top-ranked symbol can only replace
 * an UNASSIGNED slot — never an active/committed one. This makes ranking
 * churn safe for open trades.
 *
 * WAIT direction: cannot be approved for a new entry. It still passes
 * through so the UI shows it as ranked-but-not-approved.
 */
import type { RankedSymbol } from "./types";
import type { CapacitySummary } from "./capacity";

export interface ApprovalInput {
  ranked: RankedSymbol[];
  capacity: CapacitySummary;
  /** Symbols with currently open (active or committed) positions. */
  openSymbols: string[];
  /** External kill switch — if true, zero new approvals. */
  onyxOverride?: "hold_all" | null;
}

export interface ApprovalDecision {
  approvedSymbols: string[];
  retainedSymbols: string[];
  benchedSymbols: string[];
  notes: string[];
}

export function decideApprovals(input: ApprovalInput): ApprovalDecision {
  const notes: string[] = [];
  if (input.onyxOverride === "hold_all") {
    notes.push("onyx_hold_all");
    return {
      approvedSymbols: [],
      retainedSymbols: [...input.openSymbols],
      benchedSymbols: input.ranked
        .filter((r) => !input.openSymbols.includes(r.symbol))
        .map((r) => r.symbol),
      notes,
    };
  }

  const openSet = new Set(input.openSymbols);

  // 1. Retention: every open symbol keeps its slot regardless of rank.
  const retained = [...input.openSymbols];

  // 2. Available entry slots for newly-approved symbols.
  const availableForNew = Math.max(0, input.capacity.maxNewEntries);
  if (availableForNew === 0) notes.push("no_new_entry_capacity");

  // 3. Rank candidates: only those in bucket='ranked' with a real trading
  //    direction (long or short) — WAIT / none never enter.
  const rankedForEntry = input.ranked
    .filter((r) => r.bucket === "ranked")
    .filter((r) => r.direction === "long" || r.direction === "short")
    .filter((r) => !openSet.has(r.symbol));

  const approved = rankedForEntry.slice(0, availableForNew).map((r) => r.symbol);
  const benched = rankedForEntry.slice(availableForNew).map((r) => r.symbol);

  if (approved.length < rankedForEntry.length) notes.push("ranked_exceeds_capacity");

  return {
    approvedSymbols: approved,
    retainedSymbols: retained,
    benchedSymbols: [
      ...benched,
      ...input.ranked
        .filter((r) => r.bucket === "ranked" && r.direction === "wait")
        .map((r) => r.symbol),
    ],
    notes,
  };
}
