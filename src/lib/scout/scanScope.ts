/**
 * Scout scan scope for the internal-company test release.
 *
 * The release contract is intentionally strict: Scout evaluates exactly the
 * four symbols in the shared orchestration configuration. Dynamic universe
 * snapshots and legacy per-user symbol rows may still exist for analytics,
 * but they cannot widen the execution-intelligence surface.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_PAPER_SYMBOLS } from "@/lib/paper/constants";

export type ScanUniverseSource = "internal_testing_allowlist";

export interface ScanUniverseSelection {
  symbols: string[];
  source: ScanUniverseSource;
  snapshotId: string | null;
  discoveredCount: number;
  eligibleCount: number;
  rejectedCount: number;
  coverageCount: number;
  cursor: number;
  nextCursor: number;
  coverage: string[];
  scannedThisCycle: number;
}

/** The hard ceiling is derived from the shared four-symbol release contract. */
export const MAX_SCAN_SYMBOLS = DEFAULT_PAPER_SYMBOLS.length;

interface SelectOpts {
  supabase: SupabaseClient;
  userId: string;
  now?: number;
  maxBatch?: number;
}

/**
 * Retained as a small deterministic utility for callers that need bounded
 * batches. The internal release fits in one batch, so production always
 * returns all four configured symbols.
 */
export function computeRotationBatch(
  coverage: string[],
  cursor: number,
  cap: number,
): { symbols: string[]; nextCursor: number } {
  const safeCap = Math.max(0, Math.min(Math.floor(cap), coverage.length));
  if (safeCap === 0 || coverage.length === 0) return { symbols: [], nextCursor: 0 };
  if (safeCap >= coverage.length) return { symbols: [...coverage], nextCursor: 0 };

  const start = ((cursor % coverage.length) + coverage.length) % coverage.length;
  const symbols = Array.from(
    { length: safeCap },
    (_, index) => coverage[(start + index) % coverage.length],
  );
  return { symbols, nextCursor: (start + safeCap) % coverage.length };
}

export async function selectScanUniverse(opts: SelectOpts): Promise<ScanUniverseSelection> {
  // Keep the existing call signature stable while making the release scope
  // independent from database rankings and per-user legacy symbol rows.
  void opts.supabase;
  void opts.userId;
  void opts.now;

  const coverage = [...DEFAULT_PAPER_SYMBOLS];
  const requestedCap = opts.maxBatch ?? MAX_SCAN_SYMBOLS;
  const { symbols, nextCursor } = computeRotationBatch(coverage, 0, requestedCap);

  return {
    symbols,
    source: "internal_testing_allowlist",
    snapshotId: null,
    discoveredCount: coverage.length,
    eligibleCount: coverage.length,
    rejectedCount: 0,
    coverageCount: coverage.length,
    cursor: 0,
    nextCursor,
    coverage,
    scannedThisCycle: symbols.length,
  };
}
