/**
 * PURE Scout → Onyx ingestion filter.
 *
 * Given a batch of raw `scout_signals` rows and a policy, returns the
 * deterministic list of (symbol, side) tuples that should be synthesized
 * into OnyxCandidates for THIS tick.
 *
 * Rules (every one is unit-tested):
 *  1. Row must be non-invalidated (invalidated_at IS NULL).
 *  2. Row must be fresh: `expires_at > nowMs`.
 *  3. Row's `regime_schema_version` must equal the caller's expected
 *     `evidenceSchemaVersion` OR be null (legacy rows pass through).
 *  4. Per side (long|short) it counts ONLY when
 *     `<side>_state === "confirmed"` AND `<side>_fresh === true`.
 *  5. Deduped by signal id: if the signal id already appears in
 *     `alreadyDecidedSignalIds` it is skipped ("delivered once" rule).
 *  6. Deduped by (symbol, side): the newest row wins.
 *  7. Both sides on one row emit two ScoutSide entries.
 *
 * NO I/O. NO Supabase. NO execution. Safe to import from anywhere.
 */
export interface RawScoutSignalRow {
  id: string;
  symbol: string;
  scan_id: string;
  created_at: string;
  expires_at: string;
  invalidated_at: string | null;
  regime_schema_version: number | null;
  market_regime: string | null;
  long_state: string;
  long_fresh: boolean;
  short_state: string;
  short_fresh: boolean;
}

export type ScoutDirection = "long" | "short";

export interface ScoutSide {
  signalId: string;
  scanId: string;
  symbol: string;
  direction: ScoutDirection;
  regime: string | null;
  createdAtMs: number;
}

export interface SelectFreshOptions {
  nowMs: number;
  evidenceSchemaVersion: number;
  alreadyDecidedSignalIds?: ReadonlySet<string>;
}

export function selectFreshScoutSides(
  rows: readonly RawScoutSignalRow[],
  opts: SelectFreshOptions,
): ScoutSide[] {
  const already = opts.alreadyDecidedSignalIds ?? new Set<string>();
  // Newest-first stable order so per-(symbol,side) dedupe keeps the newest.
  const sorted = [...rows].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const seenSide = new Set<string>();
  const out: ScoutSide[] = [];
  for (const row of sorted) {
    if (row.invalidated_at != null) continue;
    if (new Date(row.expires_at).getTime() <= opts.nowMs) continue;
    if (
      row.regime_schema_version != null &&
      row.regime_schema_version !== opts.evidenceSchemaVersion
    ) continue;
    if (already.has(row.id)) continue;
    const createdAtMs = new Date(row.created_at).getTime();
    if (row.long_state === "confirmed" && row.long_fresh === true) {
      const k = `${row.symbol}:long`;
      if (!seenSide.has(k)) {
        seenSide.add(k);
        out.push({
          signalId: row.id, scanId: row.scan_id, symbol: row.symbol,
          direction: "long", regime: row.market_regime ?? null, createdAtMs,
        });
      }
    }
    if (row.short_state === "confirmed" && row.short_fresh === true) {
      const k = `${row.symbol}:short`;
      if (!seenSide.has(k)) {
        seenSide.add(k);
        out.push({
          signalId: row.id, scanId: row.scan_id, symbol: row.symbol,
          direction: "short", regime: row.market_regime ?? null, createdAtMs,
        });
      }
    }
  }
  return out;
}
